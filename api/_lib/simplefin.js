// SimpleFIN protocol layer — claim flow, the single /accounts GET, and the
// mapping from SimpleFIN's wire JSON onto this app's row shapes.
//
// Server-side only: the access URL embeds HTTP Basic bank credentials.
//
// Verified against simplefin.org/protocol.md plus two independent client
// libraries (Go, Rust/Python) at build time (2026-07). Facts that mapping
// correctness hinges on, and how they were settled:
//
//   • amount / balance / available-balance arrive as numeric STRINGS, not JSON
//     numbers, and are not always tidy ("-05.50" is real). Always Number()-parse.
//   • amount sign is the OPPOSITE of Plaid's: SimpleFIN positive = money INTO
//     the account. This app follows Plaid (positive = money OUT), so every
//     amount is negated on the way in. Confirmed in the spec text and by the
//     Firefly-III importer's deposit branch.
//   • posted / transacted_at / balance-date are epoch SECONDS (integers).
//   • SimpleFIN sends NO account type, NO subtype, NO mask and NO category.
//     Type is inferred from the account name (see inferAccountType) and the
//     category is derived from the descriptor at write time (src/txClassify.js).
//   • The wire format has two shapes and the Bridge may serve either:
//       v1  { errors: [...], accounts: [ { org: {...}, ... } ] }
//       v2  { errlist: [...], connections: [...], accounts: [ { conn_id, ... } ] }
//     normalizeAccountSet() accepts both and hands back one shape.
//
// UNRESOLVED (deliberately): how a credit-card / loan balance is SIGNED. No
// spec text, no library, and no fixture settles it — see normalizeBalance().

const DEFAULT_TIMEOUT_MS = 30_000;

// SimpleFIN ids are stable, so they are the dedup key. Prefixed the way CSV
// import prefixes 'csv:' and manual accounts prefix 'manual:', which keeps each
// adapter's id space self-describing and non-colliding.
export const SFIN_PREFIX = 'sfin:';

export function isSimpleFinAccount(a) {
  return String(a?.plaid_account_id || '').startsWith(SFIN_PREFIX);
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// How far back the very first pull reaches, and how much overlap each
// incremental pull re-requests (a bank can amend or late-post a transaction
// after we've already pulled its date — the upsert makes re-seeing it free).
export const FIRST_PULL_DAYS = envInt('SIMPLEFIN_FIRST_PULL_DAYS', 730);
export const OVERLAP_DAYS = envInt('SIMPLEFIN_OVERLAP_DAYS', 30);

// SimpleFIN refreshes bank data roughly once a day, so pulling more often than
// this gains nothing and just leans on the Bridge. The dashboard triggers a
// sync on every load, so without this a couple of phones would happily make
// dozens of pulls a day.
export const MIN_PULL_MINUTES = envInt('SIMPLEFIN_MIN_PULL_MINUTES', 60);

// Pending transactions are OFF by default. SimpleFIN has no "removed" signal
// (unlike Plaid's transactionsSync), so if a pending row's id changes when it
// posts, the pending copy would be stranded in the ledger forever with nothing
// to clean it up. Posted-only is the safe default; flip the env var to try it.
export const INCLUDE_PENDING = process.env.SIMPLEFIN_INCLUDE_PENDING === '1';

export class SimpleFinError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = 'SimpleFinError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Setup token → claim URL → access URL
// ---------------------------------------------------------------------------

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

// The setup token is user-supplied and the server then POSTs to whatever URL it
// decodes to, so it is an SSRF vector aimed at Vercel's internal network. The
// household login is trusted, but a cloud metadata endpoint is one paste away
// from a phished token, and the check is nearly free. Hosts are blocked rather
// than allow-listed because a self-hosted SimpleFIN server is legitimate.
const BLOCKED_HOST_RE = new RegExp(
  [
    '^localhost$',
    '\\.local$',
    '\\.internal$',
    '^127\\.',
    '^0\\.',
    '^10\\.',
    '^192\\.168\\.',
    '^172\\.(1[6-9]|2\\d|3[01])\\.',
    '^169\\.254\\.', // link-local, incl. 169.254.169.254 metadata
    // IPv6 literals only — URL.hostname always brackets them, so requiring the
    // bracket keeps the pattern from swallowing ordinary hostnames that merely
    // start with the same letters (fdic.gov, fcu-bridge.example.com).
    '^\\[::1\\]$',
    '^\\[f[cd][0-9a-f]{0,2}:', // unique-local fc00::/7
    '^\\[fe[89ab][0-9a-f]?:', // link-local fe80::/10
    '^\\[::ffff:', // IPv4-mapped, e.g. [::ffff:127.0.0.1]
  ].join('|'),
  'i'
);

function assertPublicHost(value) {
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    throw new SimpleFinError('invalid_token', 'That is not a valid URL.');
  }
  if (!host || BLOCKED_HOST_RE.test(host)) {
    throw new SimpleFinError(
      'invalid_token',
      'That token points at a private network address, which SimpleFIN never does.'
    );
  }
}

// A SimpleFIN setup token is a base64-encoded claim URL. Users paste it out of
// the Bridge UI, so it arrives with stray whitespace and newlines; some paste
// the claim URL itself, and some paste an access URL they already hold.
// Returns { kind: 'claim'|'access', url }.
export function decodeSetupToken(raw) {
  const input = String(raw ?? '').trim();
  if (!input) throw new SimpleFinError('invalid_token', 'Paste your SimpleFIN setup token.');

  // Already a URL? Then it's either a claim URL or a ready-made access URL —
  // an access URL carries Basic-auth credentials, a claim URL doesn't.
  if (/^https?:\/\//i.test(input)) {
    if (!isHttpsUrl(input)) {
      throw new SimpleFinError('invalid_token', 'SimpleFIN URLs must use https.');
    }
    assertPublicHost(input);
    const parsed = new URL(input);
    return { kind: parsed.username ? 'access' : 'claim', url: input };
  }

  const compact = input.replace(/\s+/g, '');
  let decoded;
  try {
    // Accept URL-safe base64 too; Buffer ignores missing padding.
    decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8')
      .trim();
  } catch {
    throw new SimpleFinError('invalid_token', "That doesn't look like a SimpleFIN setup token.");
  }
  if (!isHttpsUrl(decoded)) {
    throw new SimpleFinError(
      'invalid_token',
      "That doesn't look like a SimpleFIN setup token — it should decode to an https claim URL."
    );
  }
  assertPublicHost(decoded);
  const parsed = new URL(decoded);
  return { kind: parsed.username ? 'access' : 'claim', url: decoded };
}

// fetch follows redirects by default, which would walk straight past
// assertPublicHost: a perfectly public claim URL can 302 to
// http://169.254.169.254/. Redirects are handled by hand instead, re-checking
// the scheme and host at every hop.
const MAX_REDIRECTS = 3;

async function fetchNoOpenRedirect(url, init, signal) {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual', signal });
    if (res.status < 300 || res.status > 399) return res;

    const location = res.headers.get('location');
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) {
      throw new SimpleFinError('too_many_redirects', 'SimpleFIN redirected too many times.');
    }

    const next = new URL(location, current).toString();
    if (!isHttpsUrl(next)) {
      throw new SimpleFinError('insecure_redirect', 'SimpleFIN redirected to a non-https URL.');
    }
    assertPublicHost(next);

    // A POST that gets a 301/302/303 would be replayed as a GET by normal fetch
    // semantics, which is meaningless for a single-use claim — refuse instead
    // of silently burning the token on the wrong request.
    if (init?.method === 'POST' && res.status !== 307 && res.status !== 308) {
      throw new SimpleFinError(
        'claim_failed',
        `SimpleFIN redirected the claim (HTTP ${res.status}). Generate a fresh setup token.`
      );
    }
    current = next;
  }
}

async function withTimeout(fn, ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new SimpleFinError('timeout', `SimpleFIN did not respond within ${ms / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// POST the claim URL once; the body of the response IS the durable access URL.
// Claim URLs are single-use — a 403 means this token was already claimed
// (possibly by an earlier attempt of ours).
export async function claimAccessUrl(claimUrl) {
  const res = await withTimeout(signal =>
    fetchNoOpenRedirect(
      claimUrl,
      {
        method: 'POST',
        // Some servers reject a POST with no length header.
        headers: { 'Content-Length': '0', Accept: 'text/plain' },
      },
      signal
    )
  );

  const body = (await res.text()).trim();
  if (res.status === 403) {
    throw new SimpleFinError(
      'token_already_claimed',
      'That setup token has already been used. Generate a fresh one in SimpleFIN Bridge.',
      { status: 403 }
    );
  }
  if (!res.ok) {
    throw new SimpleFinError(
      'claim_failed',
      `SimpleFIN rejected the setup token (HTTP ${res.status}). ${body.slice(0, 200)}`.trim(),
      { status: res.status }
    );
  }
  if (!isHttpsUrl(body) || !new URL(body).username) {
    throw new SimpleFinError(
      'claim_failed',
      'SimpleFIN returned something that is not an access URL. Try generating a new setup token.'
    );
  }
  // The claim response is attacker-influenced too — it decides where every
  // later pull goes, so it gets the same private-address check.
  assertPublicHost(body);
  return body;
}

// Split the credentials out of the access URL. Node's fetch (undici) REFUSES a
// URL containing userinfo — "Request cannot be constructed from a URL that
// includes credentials" — so they have to travel as a real Authorization
// header. Returns { base, authorization }.
export function splitAccessUrl(accessUrl) {
  let parsed;
  try {
    parsed = new URL(String(accessUrl || ''));
  } catch {
    throw new SimpleFinError('invalid_access_url', 'Stored SimpleFIN access URL is not a URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new SimpleFinError('invalid_access_url', 'SimpleFIN access URL must use https.');
  }
  // Re-checked on every pull, not just at claim time, so a URL stored before
  // this guard existed can't quietly keep pointing somewhere internal.
  assertPublicHost(parsed.toString());
  // URL keeps these percent-encoded; Basic auth needs the raw bytes.
  const user = decodeURIComponent(parsed.username || '');
  const pass = decodeURIComponent(parsed.password || '');
  parsed.username = '';
  parsed.password = '';

  // Normalize the path to the SimpleFIN root: tolerate a trailing slash, and a
  // URL someone already appended /accounts to.
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/accounts')) path = path.slice(0, -'/accounts'.length);
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';

  return {
    base: parsed.toString().replace(/\/+$/, ''),
    authorization: user || pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : null,
  };
}

// ---------------------------------------------------------------------------
// GET {access_url}/accounts
// ---------------------------------------------------------------------------

export function toEpochSeconds(date) {
  const ms = date instanceof Date ? date.getTime() : new Date(date).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

// opts: { startDate (Date|iso), endDate, pending, balancesOnly, accountIds[] }
// The `version` param is deliberately NOT sent. The spec says "the server
// chooses the default version if this is not specified", so pinning it would
// mean guessing which of v1/v2 the Bridge is happiest serving — and
// normalizeAccountSet() reads either shape, which is the better defense.
export function buildAccountsUrl(base, opts = {}) {
  const url = new URL(`${base}/accounts`);
  const start = opts.startDate != null ? toEpochSeconds(opts.startDate) : null;
  const end = opts.endDate != null ? toEpochSeconds(opts.endDate) : null;
  // start-date is inclusive; end-date is EXCLUSIVE ("before but not on").
  if (start != null) url.searchParams.set('start-date', String(start));
  if (end != null) url.searchParams.set('end-date', String(end));
  if (opts.pending) url.searchParams.set('pending', '1');
  if (opts.balancesOnly) url.searchParams.set('balances-only', '1');
  // `account` is repeatable, not comma-joined.
  for (const id of opts.accountIds || []) url.searchParams.append('account', id);
  return url.toString();
}

export async function fetchAccountSet(accessUrl, opts = {}) {
  const { base, authorization } = splitAccessUrl(accessUrl);
  const url = buildAccountsUrl(base, opts);

  const res = await withTimeout(
    signal =>
      fetchNoOpenRedirect(
        url,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            ...(authorization ? { Authorization: authorization } : {}),
          },
        },
        signal
      ),
    opts.timeoutMs || DEFAULT_TIMEOUT_MS
  );

  if (res.status === 403) {
    throw new SimpleFinError(
      'auth_failed',
      'SimpleFIN rejected the stored credentials (403). The access URL was revoked — reconnect with a new setup token.',
      { status: 403 }
    );
  }
  if (res.status === 402) {
    throw new SimpleFinError(
      'payment_required',
      'SimpleFIN says payment is required (402). Check the subscription on your SimpleFIN Bridge account.',
      { status: 402 }
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new SimpleFinError('http_error', `SimpleFIN returned HTTP ${res.status}. ${body}`.trim(), {
      status: res.status,
    });
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new SimpleFinError(
      'bad_response',
      `SimpleFIN returned a non-JSON body: ${text.slice(0, 200)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Wire JSON → normalized shape (accepts protocol v1 and v2)
// ---------------------------------------------------------------------------

// Numeric strings, sometimes zero-padded ("-05.50"). Blank/absent → null,
// never 0: a missing balance must not read as a zero balance.
export function parseMoney(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim().replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Epoch seconds → ISO date (YYYY-MM-DD), in UTC.
//
// Note for the Plaid-vs-SimpleFIN diff: if SimpleFIN reports a real posting
// *moment* rather than a date-at-midnight, a late-evening US transaction lands
// on the next UTC day and can drift across a month boundary. Comparing a month
// of SimpleFIN against the same month of Plaid is exactly what surfaces that.
export function epochToIsoDate(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function epochToIsoTimestamp(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Stable per-household identity for a SimpleFIN org, used to find-or-create the
// institution row. Prefer the server-assigned id; fall back to the domain, then
// the name — whichever exists, it has to stay stable across pulls or every
// sync would create duplicate institutions.
export function orgKey(org) {
  const id = String(org?.id || '').trim();
  if (id) return id;
  const domain = String(org?.domain || '').trim().toLowerCase();
  if (domain) return `domain:${domain}`;
  // sfin-url is the ONLY org field the protocol actually requires — id, domain
  // and name are all optional. Without it in the chain, two identity-poor orgs
  // would both fall through to the caller's 'unknown' bucket and get merged
  // into one institution.
  const sfinHost = hostOf(org?.['sfin-url'] || org?.sfinUrl || '');
  if (sfinHost) return `sfin:${sfinHost.toLowerCase()}`;
  const url = hostOf(org?.url || '');
  if (url) return `domain:${url.toLowerCase()}`;
  const name = String(org?.name || '').trim().toLowerCase();
  if (name) return `name:${name}`;
  return '';
}

export function orgLabel(org) {
  return (
    String(org?.name || '').trim() ||
    String(org?.domain || '').trim() ||
    hostOf(org?.url) ||
    'Bank'
  );
}

// v2 replaces the per-account `org` object with a top-level `connections` array
// joined by `conn_id`. Flatten a connection into the v1 org shape. Note v2's
// `name` is the *connection's* label ("My Bank - Jill"), so the org's own name
// wins when it's there.
function orgFromConnection(conn) {
  if (!conn) return null;
  return {
    // Deliberately NOT falling back to conn_id. conn_id identifies the
    // *connection*, not the org, and using it would make orgKey return a
    // different value than v1's domain/name fallback for the same bank — so a
    // server-side version flip would fork the institution. Leaving it empty
    // lets orgKey walk the same fallback chain both versions can satisfy.
    id: conn.org_id || '',
    name: conn.org_name || conn.name || '',
    domain: hostOf(conn.org_url) || '',
    url: conn.org_url || '',
    'sfin-url': conn.sfin_url || '',
  };
}

// The protocol tells applications to sanitize anything from /accounts before
// showing it to a user: these strings come from the bank via the Bridge, land
// in the UI, and are not ours. Strip control characters and markup, collapse
// whitespace, cap the length.
export function sanitizeFeedMessage(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// v1 `errors` is an array of plain strings. The v2 draft deprecates it in
// favour of `errlist`, an array of { code, msg, conn_id?, account_id? }.
function readFeedError(entry) {
  if (entry == null) return '';
  if (typeof entry === 'string') return sanitizeFeedMessage(entry);
  const msg = sanitizeFeedMessage(entry.msg || entry.message || '');
  const code = sanitizeFeedMessage(entry.code || '');
  if (msg && code) return `${msg} (${code})`;
  return msg || code || sanitizeFeedMessage(JSON.stringify(entry));
}

// Account-type inference. SimpleFIN sends no type/subtype, but the whole
// cash-flow model keys off them (isCheckingAccount / isHouseholdDepository in
// dataAdapter.js), so a wrong guess quietly distorts Trends. The name is all
// there is to go on, so the guess is INSERT-ONLY: api/sync.js writes it when it
// first sees an account and never again, and the Accounts tab lets the type be
// corrected by hand. Order matters — investments and loans first, then the
// deposit words, then card words (so "Discover Bank Savings" and "Cash Rewards
// Checking" resolve as deposit accounts, not cards).
const TYPE_RULES = [
  [/\b(brokerage|invest|investment|401\s?k|403\s?b|\bira\b|roth|hsa|portfolio|securities|mutual fund)\b/i, { type: 'investment', subtype: 'brokerage' }],
  [/\b(mortgage|home loan|auto loan|car loan|student loan|personal loan|loan|heloc|line of credit|lending)\b/i, { type: 'loan', subtype: 'loan' }],
  [/\b(savings|saver|save|money market|\bmma\b|certificate|\bcd\b|holiday|christmas club|emergency fund|share savings)\b/i, { type: 'depository', subtype: 'savings' }],
  [/\b(checking|chequing|share draft|debit|spending|everyday|current account)\b/i, { type: 'depository', subtype: 'checking' }],
  [/\b(credit card|visa|mastercard|master card|amex|american express|discover card|platinum|signature|rewards card|cash ?back|\bcredit\b|\bcard\b)\b/i, { type: 'credit', subtype: 'credit card' }],
];

export function inferAccountType(name, org) {
  const haystack = `${String(name || '')} ${String(org?.name || '')}`;
  for (const [re, out] of TYPE_RULES) {
    if (re.test(haystack)) return { ...out, inferred: true };
  }
  // Nothing matched. Depository/checking is the commonest account and keeps the
  // row visible in every view so a wrong guess is noticed and corrected, rather
  // than silently vanishing from the dashboard.
  return { type: 'depository', subtype: 'checking', inferred: true, uncertain: true };
}

// Normalize the reported balance so `current_balance` means what the rest of
// the app assumes: for credit/loan, positive = money OWED (Plaid's convention).
//
// ⚠ UNVERIFIED. Nothing in the SimpleFIN spec, in any client library, or in the
// demo fixture says how a debt balance is signed — the demo only exposes
// positive-balance deposit accounts. The rule below assumes a card reported as
// -1,234.56 means $1,234.56 owed, and that a positive number on a card already
// means "owed". It gets the rare overpaid/credit-balance card wrong under either
// convention. Deposit balances are unambiguous and pass through untouched.
//
// This must be checked against a real linked card before the Debt tracker
// trusts it — api/sync.js logs the raw feed value for exactly that reason.
export function normalizeBalance(type, balance) {
  if (balance == null) return null;
  if (type !== 'credit' && type !== 'loan') return balance;
  return balance < 0 ? -balance : balance;
}

export function normalizeTransaction(tx) {
  const externalId = String(tx?.id ?? '').trim();
  if (!externalId) return null;

  const amountIn = parseMoney(tx?.amount);
  if (amountIn == null) return null;

  // posted is the authoritative date; transacted_at is when the purchase
  // happened and is optional (and 0 when absent — never let that become 1970).
  const date = epochToIsoDate(tx?.posted) || epochToIsoDate(tx?.transacted_at);
  if (!date) return null;

  const payee = String(tx?.payee ?? '').trim();
  const description = String(tx?.description ?? '').trim();
  const memo = String(tx?.memo ?? '').trim();

  return {
    externalId,
    date,
    // Sign flip: SimpleFIN positive = money in; this app = positive money out.
    amount: Number((-amountIn).toFixed(2)),
    // payee is the cleaner merchant string when the server bothers to send one.
    payee,
    description: description || payee || memo || 'Transaction',
    memo,
    pending: !!tx?.pending,
  };
}

export function normalizeAccount(account, orgLookup) {
  const externalId = String(account?.id ?? '').trim();
  if (!externalId) return null;

  const org = account?.org || orgFromConnection(orgLookup?.get(account?.conn_id)) || {};
  const balance = parseMoney(account?.balance);

  return {
    externalId,
    name: String(account?.name ?? '').trim() || 'Account',
    currency: String(account?.currency || 'USD').trim() || 'USD',
    balance,
    availableBalance: parseMoney(account?.['available-balance']),
    balanceDate: epochToIsoTimestamp(account?.['balance-date']),
    org: {
      key: orgKey(org),
      label: orgLabel(org),
      domain: String(org?.domain || '').trim(),
      url: String(org?.url || org?.['sfin-url'] || '').trim(),
    },
    transactions: (Array.isArray(account?.transactions) ? account.transactions : [])
      .map(normalizeTransaction)
      .filter(Boolean),
  };
}

// One shape out, whichever protocol version came in.
// Returns { errors: string[], accounts: NormalizedAccount[], skipped: number }.
export function normalizeAccountSet(json) {
  const errors = []
    // v1 calls it "errors" (plain strings); the v2 draft deprecates that in
    // favour of "errlist" (objects). readFeedError flattens and sanitizes both.
    .concat(Array.isArray(json?.errors) ? json.errors : [])
    .concat(Array.isArray(json?.errlist) ? json.errlist : [])
    .map(readFeedError)
    .filter(Boolean);

  // v2 only: orgs live in a top-level connections array joined by conn_id.
  const orgLookup = new Map();
  for (const conn of Array.isArray(json?.connections) ? json.connections : []) {
    if (conn?.conn_id) orgLookup.set(conn.conn_id, conn);
  }

  const rawAccounts = Array.isArray(json?.accounts) ? json.accounts : [];
  const accounts = rawAccounts.map(a => normalizeAccount(a, orgLookup)).filter(Boolean);

  return { errors, accounts, skipped: rawAccounts.length - accounts.length };
}
