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

// SimpleFIN serves at most 90 days per request, and says so in the response
// BODY when you ask for more ("Requested date range exceeds limit of 90 days and
// was capped."). Asking for more than it serves gains nothing and truncates the
// response at the old end, so every open-ended request is clamped to just inside
// that ceiling.
//
// FIRST_PULL_DAYS above is deliberately NOT lowered to match. It stays the reach
// we'd LIKE, so the difference between wanted and served is a coverage shortfall
// the caller can report — redefining the constant would erase the only signal
// that older history was never fetched. Statement import is how that history
// gets in (see CLAUDE.md).
export const MAX_LOOKBACK_DAYS = envInt('SIMPLEFIN_MAX_LOOKBACK_DAYS', 88);

const DAY_MS = 86400000;

// Pure: clamp an open-ended "since" start to MAX_LOOKBACK_DAYS before `now`.
// Returns the start to actually request plus whether it had to move, so the
// caller can report the shortfall instead of silently losing the window.
export function clampStartDate(startMs, nowMs) {
  // Accepts the same inputs as toEpochSeconds (Date | ISO string | epoch ms),
  // because fetchAccountSet's own JSDoc advertises `startDate: Date|iso`. A
  // string used to fall through as NaN, and the caller then wrapped NaN in a
  // Date — which buildAccountsUrl drops silently, turning a bounded request into
  // "every transaction the Bridge holds".
  const toMs = v =>
    v instanceof Date ? v.getTime() : typeof v === 'string' ? new Date(v).getTime() : Number(v);
  const start = toMs(startMs);
  const now = toMs(nowMs);
  if (!Number.isFinite(start) || !Number.isFinite(now)) {
    return { startMs: start, clamped: false };
  }
  const floor = now - MAX_LOOKBACK_DAYS * DAY_MS;
  return start < floor ? { startMs: floor, clamped: true } : { startMs: start, clamped: false };
}

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
  // Clamp here, not at the call sites: there are two open-ended ones (the
  // incremental pull and the new-account history backfill) and the backfill asks
  // for FIRST_PULL_DAYS outright, so a clamp applied only to the incremental
  // path would still let the backfill trip the hard cap and truncate. Callers
  // that want the shortfall reported use clampStartDate themselves; this is the
  // backstop that makes it structural.
  //
  // Skipped when an explicit endDate is present — that's a bounded window
  // request, not an open-ended "everything since", and clamping its start would
  // silently shrink a deliberate range.
  const clamped =
    opts.startDate != null && opts.endDate == null
      ? { ...opts, startDate: new Date(clampStartDate(opts.startDate, Date.now()).startMs) }
      : opts;
  const url = buildAccountsUrl(base, clamped);

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
//
// Flattened to one shape that KEEPS the structure classifyFeedMessage needs:
// `code` (an allowlisted advisory code beats prose matching) and `perBank`
// (an entry pinned to one connection/account is that bank's problem, whatever
// its wording). The old version returned only the display string and threw both
// away, which left text matching as the only possible discriminator.
function readFeedEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    const text = sanitizeFeedMessage(entry);
    return text ? { text, code: '', perBank: false } : null;
  }
  const msg = sanitizeFeedMessage(entry.msg || entry.message || '');
  const code = sanitizeFeedMessage(entry.code || '');
  const perBank = !!(entry.conn_id || entry.account_id);
  const text =
    msg && code ? `${msg} (${code})` : msg || code || sanitizeFeedMessage(JSON.stringify(entry));
  return text ? { text, code, perBank } : null;
}

// ---------------------------------------------------------------------------
// Feed messages: a broken bank, or a note about the request WE made?
//
// SimpleFIN returns both in the same errors/errlist array, and api/sync.js used
// to count every entry as a bank error. That deadlocked the whole feed: the
// watermark only advances on an error-free pull, so it stayed NULL, so the next
// pull asked for the same oversized window, which re-emitted the same notice —
// forever, while each pull happily wrote hundreds of transactions. It also
// blocked CSV/PDF import into every SimpleFIN account, because pullWasClean
// treats any `warnings` as unclean. See the advisory gotcha in CLAUDE.md.
//
// Three kinds:
//   'error'    — a real problem (credentials, billing, a bank that won't
//                answer). Holds the watermark and blocks statement import.
//   'advisory' — a note about our request that cost us nothing.
//   'capped'   — our range was truncated: the data we got is usable, but older
//                transactions inside the window were never returned. Usable, so
//                it must not hold the watermark (stalling recovers nothing — the
//                next pull computes the same start and is served the same
//                truncated response), but it IS a coverage shortfall to report.
//
// Polarity is an ALLOWLIST: only a recognised note is downgraded, so anything
// SimpleFIN invents next stays an error and fails loudly. A denylist would
// silently swallow the next unfamiliar real failure.
// ---------------------------------------------------------------------------

// Matched CONJUNCTIVELY (a range subject AND a limit word) rather than as a
// fixed phrase, so a rewording still lands. Anchored at neither end on purpose:
// readFeedEntry appends " (CODE)" and sanitizeFeedMessage truncates at 300
// chars, so neither the head nor the tail of the original sentence is
// guaranteed to survive intact.
const RANGE_SUBJECT_RE = /\bdate range\b|\brange requested\b|\brequested\s+(date\s+)?range\b/i;
const RANGE_LIMIT_RE = /\b(exceed|exceeds|exceeded|limit|maximum|recommended|cap|capped)\b/i;
// Past tense only: "was capped" means data was truncated, "may be capped" is a
// warning about future requests. Getting this ordering wrong is the difference
// between reporting a real coverage gap and inventing one.
const CAPPED_RE = /\b(was|were|been)\s+capped\b/i;
// "…this MAY BE capped" is a warning about future requests, not a report that
// this one was truncated. Without this exclusion the bare-"capped" test below
// would read the 45-day advisory as a coverage shortfall and invent a gap.
const FUTURE_CAP_RE = /\b(may|might|could|will|can|would|shall)\s+be\s+capped\b/i;
// Wording that means a BANK needs attention. Vetoes the range match, because
// bank names and feed prose are attacker-ish free text: a real credential
// failure that happens to quote our request must stay an error.
// Deliberately generous, because every word added here can only move a message
// toward 'error' — the fail-safe direction. Two shapes matter especially:
// SimpleFIN's canonical phrasing is "may need attention", so matching only
// "needs attention" would miss it; and "authentication failed" shares no prefix
// with "reauthenticate", so the stem is matched rather than the re- form.
// Stems carry an explicit \w* — a bare `\bauthenticat\b` cannot match
// "Authentication", because the trailing word boundary fails against the "ion".
// That silently let "Authentication error: requested date range exceeds limit of
// 90 days." classify as 'capped'.
const REAL_TROUBLE_RE =
  /\b(reconnect|authenticat\w*|credential\w*|password|login|logged\s+out|need(s|ed)?\s+attention|payment\s+required|subscription|expired|revoked|denied|mfa|multi-?factor|forbidden|unauthoriz\w*|locked|suspend\w*|invalid|rate\s+limit|try\s+again|unavailable|timed?\s*out|error|fail\w*|unable\s+to)\b/i;

// v2 code forms, normalized to A_Z_0_9. An allowlisted code is authoritative:
// it beats both the per-bank structural veto and the prose tests, because it is
// SimpleFIN telling us the kind directly.
const ADVISORY_CODES = new Set(['DATE_RANGE_EXCEEDED', 'DATE_RANGE_RECOMMENDED']);
const CAPPED_CODES = new Set(['DATE_RANGE_CAPPED', 'DATE_RANGE_TRUNCATED']);

function normalizeCodeKey(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Accepts a raw feed entry (v1 string or v2 object) or an already-flattened
// { text, code, perBank }. Returns 'error' | 'advisory' | 'capped'.
export function classifyFeedMessage(entry) {
  const e =
    entry && typeof entry === 'object' && typeof entry.text === 'string'
      ? entry
      : readFeedEntry(entry);
  if (!e) return 'error';

  // Trouble wording is checked FIRST, ahead of the code allowlist. The code
  // names below are our guess — SimpleFIN publishes no code vocabulary — so they
  // are the least trustworthy signal in this function and must not outrank the
  // most trustworthy one. Before this ordering, an entry like
  // { code: 'DATE_RANGE_EXCEEDED', msg: 'Please reconnect BECU - credentials
  // expired', conn_id: 'c1' } was downgraded to 'advisory': a revoked-credential
  // failure that would have advanced the watermark and cleared last_error.
  if (REAL_TROUBLE_RE.test(e.text)) return 'error';

  // Only the v2 `code` field is matched against the code sets — deliberately NOT
  // the prose. Falling back to the message text let a per-bank entry whose
  // wording happened to normalize onto a code key ("Date range capped" with a
  // conn_id) skip the veto below. A code is SimpleFIN naming the kind outright,
  // so it may outrank per-bank structure — but not the trouble test above.
  const codeKey = normalizeCodeKey(e.code);
  if (codeKey) {
    if (CAPPED_CODES.has(codeKey)) return 'capped';
    if (ADVISORY_CODES.has(codeKey)) return 'advisory';
  }

  if (e.perBank) return 'error';
  if (!(RANGE_SUBJECT_RE.test(e.text) && RANGE_LIMIT_RE.test(e.text))) return 'error';

  // capped vs advisory. Past-tense "was capped" is unambiguous, but it sits at
  // the END of the sentence and sanitizeFeedMessage truncates at 300 chars, so
  // relying on it alone would let a clipped cap notice degrade to 'advisory' —
  // silently losing a coverage shortfall. The two live messages also differ near
  // the HEAD, which survives truncation:
  //   "…exceeds LIMIT of 90 days and was capped."          -> a ceiling truncated us
  //   "…exceeds RECOMMENDED range of 45 days. …may be capped." -> a suggestion
  // so `recommended` is checked before the hard-limit words, and a bare limit
  // statement is read as truncation.
  if (CAPPED_RE.test(e.text)) return 'capped';
  // Any other mention of capping that isn't explicitly about FUTURE requests is
  // read as truncation. Erring toward 'capped' is the safe direction: it reports
  // a coverage shortfall the user can fill from a statement, whereas erring
  // toward 'advisory' would silently drop a window the feed never served.
  if (/\bcapped\b/i.test(e.text) && !FUTURE_CAP_RE.test(e.text)) return 'capped';
  if (/\brecommended\b/i.test(e.text)) return 'advisory';
  if (/\b(limit|maximum)\b/i.test(e.text)) return 'capped';
  return 'advisory';
}

// The sync-level consequence of message classification: what the pull writes
// back to simplefin_access. Extracted pure (api/sync.js applies the returned
// patch) because the failure mode it prevents — the advisory deadlock — had
// NO alarm anywhere: a watermark that never advances just looks like a feed
// that hasn't synced yet.
//
//   • No real errors → last_pulled_at advances and last_error clears.
//     Advisories and CAPPED ranges are NOT errors — a capped range must not
//     hold the watermark (stalling recovers nothing: the next pull computes
//     the same start and is served the same truncated window; the shortfall
//     is *reported* via coverageShortfall instead).
//   • Real errors → the watermark holds (advancing would skip the broken
//     bank's outage window once it exceeded the overlap) and last_error
//     records them, truncated.
//   • A failed new-account history backfill CLEARS the watermark so the next
//     pull is a full-history one — the accounts will no longer look "new", so
//     nothing else would ever re-trigger the backfill.
export function watermarkUpdate({ errors = [], backfillFailed = false, nowIso }) {
  const clean = errors.length === 0;
  return {
    ...(backfillFailed
      ? { last_pulled_at: null }
      : clean
        ? { last_pulled_at: nowIso }
        : {}),
    last_error: clean ? null : errors.join('; ').slice(0, 1000),
  };
}

// The window we wanted vs what the feed can serve, as a reportable object —
// null when the request wasn't clamped. Nothing downstream can recover a
// clamped window (statement import is the path), so it is surfaced rather
// than silently dropped, and NEVER expressed by stalling the watermark.
export function coverageShortfall(wantedStartMs, nowMs) {
  const { startMs, clamped } = clampStartDate(wantedStartMs, nowMs);
  if (!clamped) return null;
  return {
    wanted_from: new Date(wantedStartMs).toISOString().slice(0, 10),
    served_from: new Date(startMs).toISOString().slice(0, 10),
  };
}

// Account-type inference. SimpleFIN sends no type/subtype, but the whole
// cash-flow model keys off them (isCheckingAccount / isHouseholdDepository in
// dataAdapter.js), so a wrong guess quietly distorts Trends. The name is all
// there is to go on, so the guess is INSERT-ONLY: api/sync.js writes it when it
// first sees an account and never again, and the Accounts tab lets the type be
// corrected by hand. Order matters — investments and loans first, then the
// deposit words, then card words (so "Discover Bank Savings" and "Cash Rewards
// Checking" resolve as deposit accounts, not cards).
// The deposit rules run BEFORE the card rules on purpose, and that ordering is
// what makes the card rules safe to write generously: a real deposit account
// claims itself first, so generic product words ("Preferred", "Platinum",
// "Unlimited", "Reserve") can sit in the card list without stealing
// "Platinum Savings" or "Preferred Checking".
const TYPE_RULES = [
  [/\b(brokerage|invest|investment|401\s?k|403\s?b|\bira\b|roth|hsa|portfolio|securities|mutual fund)\b/i, { type: 'investment', subtype: 'brokerage' }],
  [/\b(mortgage|home loan|auto loan|car loan|student loan|personal loan|loan|heloc|line of credit|lending)\b/i, { type: 'loan', subtype: 'loan' }],
  [/\b(savings|saver|save|money market|\bmma\b|certificate|\bcd\b|holiday|christmas club|emergency fund|share savings)\b/i, { type: 'depository', subtype: 'savings' }],
  // "everyday" was removed as a bare word: "Blue Cash Everyday" and "Amex
  // EveryDay" are CARDS, and it was claiming them for checking. Wells Fargo's
  // "Everyday Checking" is still matched, by the word "checking".
  [/\b(checking|chequing|share draft|debit|spending|current account)\b/i, { type: 'depository', subtype: 'checking' }],
  // Card product names carry no card-ish word at all — "Venture X", "Freedom
  // Unlimited", "Quicksilver" — which is how a Capital One Venture X landed as
  // checking and would have counted 348 card purchases as household spending.
  [/\b(credit card|visa|mastercard|master card|amex|american express|discover card|rewards card|cash ?back|\bcredit\b|\bcard\b)\b/i, { type: 'credit', subtype: 'credit card' }],
  [/\b(venture|quicksilver|savor(one)?|spark|freedom|sapphire|slate|\bink\b|reserve|preferred|unlimited|double cash|active cash|custom cash|altitude|propel|bonvoy|skymiles|aadvantage|rapid rewards|hyatt|platinum|signature|gold)\b/i, { type: 'credit', subtype: 'credit card' }],
];

// Issuers that essentially only issue cards. Capital One and Chase are NOT here
// — they both offer checking, so their name alone proves nothing.
const CARD_ONLY_ISSUER_RE = /\b(american express|amex|discover|barclaycard|barclays|synchrony|comenity|credit one|first premier|bread financial)\b/i;

export function inferAccountType(name, org, balance) {
  const haystack = `${String(name || '')} ${String(org?.name || '')}`;
  for (const [re, out] of TYPE_RULES) {
    if (re.test(haystack)) return { ...out, inferred: true };
  }
  if (CARD_ONLY_ISSUER_RE.test(String(org?.name || ''))) {
    return { type: 'credit', subtype: 'credit card', inferred: true };
  }
  // Last resort before the fallback: SimpleFIN reports a debt balance as
  // NEGATIVE when money is owed (confirmed against a real Capital One card), and
  // a deposit account is only negative while overdrawn — rare, and not usually
  // the state it's in at sync time. So a negative balance on an otherwise
  // unrecognisable account is much more likely a card than a checking account.
  if (typeof balance === 'number' && balance < 0) {
    return { type: 'credit', subtype: 'credit card', inferred: true, uncertain: true };
  }
  // Nothing matched. Depository/checking is the commonest account and keeps the
  // row visible in every view so a wrong guess is noticed and corrected, rather
  // than silently vanishing from the dashboard.
  return { type: 'depository', subtype: 'checking', inferred: true, uncertain: true };
}

// Normalize the reported balance so `current_balance` means what the rest of
// the app assumes: for credit/loan, positive = money OWED (Plaid's convention).
//
// CONFIRMED against a real linked card (Capital One Venture X, 2026-07):
// SimpleFIN reports a credit-card balance as NEGATIVE when money is owed — the
// feed sent -5127.97 for a card with $5,127.97 outstanding, matching Plaid's
// +5127.97 for the same card after this flip. Nothing in the spec, any client
// library, or the demo fixture said so; the demo only exposes positive-balance
// deposit accounts, so it took live data.
//
// Still approximate at one boundary: an OVERPAID card (the bank owes you) would
// be reported positive and is left positive here, i.e. shown as owed. Rare, and
// small when it happens. Deposit balances are unambiguous and pass through.
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

// One shape out, whichever protocol version came in. Returns
// { errors, advisories, capped, accounts, skipped } — the three message arrays
// are split by classifyFeedMessage above, and ONLY `errors` may hold a pull back
// (see the advisory gotcha in CLAUDE.md).
export function normalizeAccountSet(json) {
  const entries = []
    // v1 calls it "errors" (plain strings); the v2 draft deprecates that in
    // favour of "errlist" (objects). readFeedEntry flattens and sanitizes both.
    .concat(Array.isArray(json?.errors) ? json.errors : [])
    .concat(Array.isArray(json?.errlist) ? json.errlist : [])
    .map(readFeedEntry)
    .filter(Boolean);

  const errors = [];
  const advisories = [];
  const capped = [];
  for (const entry of entries) {
    const kind = classifyFeedMessage(entry);
    if (kind === 'capped') capped.push(entry.text);
    else if (kind === 'advisory') advisories.push(entry.text);
    else {
      errors.push(entry.text);
      // Logged verbatim because the allowlist's failure mode IS the production
      // bug: a benign notice counted as an error stalls the watermark with no
      // alarm anywhere. This line is where an unfamiliar one shows up.
      console.warn('[simplefin] feed message treated as a real error: %s', entry.text);
    }
  }

  // v2 only: orgs live in a top-level connections array joined by conn_id.
  const orgLookup = new Map();
  for (const conn of Array.isArray(json?.connections) ? json.connections : []) {
    if (conn?.conn_id) orgLookup.set(conn.conn_id, conn);
  }

  const rawAccounts = Array.isArray(json?.accounts) ? json.accounts : [];
  const accounts = rawAccounts.map(a => normalizeAccount(a, orgLookup)).filter(Boolean);

  return {
    errors,
    advisories,
    capped,
    accounts,
    skipped: rawAccounts.length - accounts.length,
  };
}
