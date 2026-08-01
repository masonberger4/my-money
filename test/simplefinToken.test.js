// SimpleFIN token/SSRF plumbing (api/_lib/simplefin.js) — a security surface
// backed by two CLAUDE.md Gotchas:
//   • the setup token is user-supplied and the server POSTs to whatever it
//     decodes to, so private-address targets must be rejected;
//   • plain fetch follows redirects, which would walk straight past the check
//     — a public claim URL can 302 to the cloud metadata endpoint.
// The host check is TWO-layered: the hostname itself (name rules + IP-literal
// classification) and a DNS resolution of names, because a public-LOOKING name
// can carry a private A/AAAA record. Every test injects a scripted resolver
// (the ruleHistory.js seam style) so nothing here touches real DNS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSetupToken,
  splitAccessUrl,
  claimAccessUrl,
  isPrivateIp,
  SimpleFinError,
} from '../api/_lib/simplefin.js';

const code = expected => err => {
  assert.ok(err instanceof SimpleFinError, `expected SimpleFinError, got ${err}`);
  assert.equal(err.code, expected);
  return true;
};

// --- scripted DNS resolvers --------------------------------------------------

const A = address => ({ address, family: address.includes(':') ? 6 : 4 });
// Any name resolves to one public IP — for tests where DNS is not the subject.
const publicDns = async () => [A('93.184.216.34')];
// DNS must never be consulted (the check should reject before resolving); if it
// IS consulted, the wrapped failure surfaces as dns_failed, which no test here
// expects, so the mistake cannot pass silently.
const neverDns = async host => {
  throw Object.assign(new Error(`unexpected DNS lookup of ${host}`), { code: 'ENOTFOUND' });
};
// Per-host table; unknown hosts fail like a dead name.
const dnsTable = table => async host => {
  const ips = table[host];
  if (!ips) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return ips.map(A);
};

// --- decodeSetupToken --------------------------------------------------------

const CLAIM_URL = 'https://bridge.simplefin.org/simplefin/claim/DEMO123';
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

test('a valid setup token decodes to its claim URL', async () => {
  assert.deepEqual(await decodeSetupToken(b64(CLAIM_URL), { lookup: publicDns }), {
    kind: 'claim',
    url: CLAIM_URL,
  });
});

test('whitespace, newlines, URL-safe base64 and missing padding are tolerated', async () => {
  const tok = b64(CLAIM_URL);
  const sloppy = `  ${tok.slice(0, 12)}\n${tok.slice(12)}  \n`;
  assert.equal((await decodeSetupToken(sloppy, { lookup: publicDns })).url, CLAIM_URL);

  // A URL crafted to produce + and / in its base64, then URL-safe-encoded
  // with the padding stripped.
  const gnarly = 'https://bridge.simplefin.org/claim/??~~>>';
  const urlSafe = b64(gnarly).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.ok(/[-_]/.test(urlSafe), 'fixture sanity: the token actually exercises URL-safe chars');
  assert.equal((await decodeSetupToken(urlSafe, { lookup: publicDns })).url, gnarly);
});

test('a pasted access URL is recognized as such (credentials present)', async () => {
  const r = await decodeSetupToken('https://u:p@bridge.example.com/simplefin', { lookup: publicDns });
  assert.equal(r.kind, 'access');
  const c = await decodeSetupToken('https://bridge.example.com/simplefin/claim/x', { lookup: publicDns });
  assert.equal(c.kind, 'claim');
});

test('http targets are rejected before any DNS lookup, pasted or decoded', async () => {
  await assert.rejects(
    () => decodeSetupToken('http://bridge.example.com/claim/x', { lookup: neverDns }),
    code('invalid_token')
  );
  await assert.rejects(
    () => decodeSetupToken(b64('http://bridge.example.com/claim/x'), { lookup: neverDns }),
    code('invalid_token')
  );
});

test('private-network literals are rejected WITHOUT resolving — incl. the ranges the regex era missed', async () => {
  for (const target of [
    'https://169.254.169.254/latest/meta-data', // cloud metadata
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x', // IPv4-mapped, dotted spelling
    'https://[::ffff:7f00:1]/x', // IPv4-mapped, the hex spelling URL serializes
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://192.168.1.5/x',
    'https://172.16.0.9/x',
    'https://[fd00::1]/x', // unique-local
    'https://[fe80::1]/x', // link-local
    'https://backend.internal/x',
    'https://mybox.local/x',
    // Gaps the old regex missed, now covered by the parsing classifier:
    'https://100.64.0.1/x', // carrier-grade NAT 100.64.0.0/10
    'https://100.127.255.255/x', // CGN upper edge (mid-octet /10 boundary)
    'https://[::]/x', // bare unspecified address
    'https://0.0.0.0/x', // 0.0.0.0/8 — connects to localhost
    'https://192.0.0.192/x', // 192.0.0.0/24 protocol assignments
    'https://198.18.0.1/x', // 198.18.0.0/15 benchmarking
    'https://[64:ff9b::8.8.8.8]/x', // NAT64 well-known prefix
    'https://[64:ff9b:1::1]/x', // NAT64 local-use 64:ff9b:1::/48
    'https://[fec0::1]/x', // site-local (deprecated)
    'https://[2001:db8::1]/x', // documentation
    'https://224.0.0.251/x', // multicast
    'https://255.255.255.255/x', // broadcast
    // Creative IPv4 spellings — WHATWG URL canonicalizes them to 127.0.0.1
    // before the check ever sees the hostname:
    'https://0177.0.0.1/x',
    'https://2130706433/x',
  ]) {
    await assert.rejects(() => decodeSetupToken(b64(target), { lookup: neverDns }), code('invalid_token'), target);
    await assert.rejects(() => decodeSetupToken(target, { lookup: neverDns }), code('invalid_token'), `pasted: ${target}`);
  }
});

test('REGRESSION: public hosts that merely LOOK bank-internal are NOT blocked', async () => {
  // The IPv6 handling requires the bracket a URL hostname always carries, so
  // ordinary names starting with the same letters must pass (given public DNS).
  for (const target of [
    'https://fdic.gov/x',
    'https://fcu-bridge.example.com/claim',
    'https://fe80cafe.example.com/x',
    'https://internal-tools.example.com/x', // "internal" not as a TLD
    'https://localhost.example.com/x', // "localhost" not as the whole host
  ]) {
    assert.equal((await decodeSetupToken(b64(target), { lookup: publicDns })).url, target, target);
  }
});

test('empty and undecodable input → invalid_token', async () => {
  await assert.rejects(() => decodeSetupToken('', { lookup: neverDns }), code('invalid_token'));
  await assert.rejects(() => decodeSetupToken('   ', { lookup: neverDns }), code('invalid_token'));
  await assert.rejects(() => decodeSetupToken('%%%%not-base64%%%%', { lookup: neverDns }), code('invalid_token'));
});

// --- the DNS half: what the name RESOLVES TO ---------------------------------

test('a public-looking name with a private A record is rejected (the DNS rebinding gap)', async () => {
  await assert.rejects(
    () => decodeSetupToken(b64('https://innocent.example.com/claim/x'), { lookup: dnsTable({ 'innocent.example.com': ['10.0.0.5'] }) }),
    code('invalid_token')
  );
  await assert.rejects(
    () => decodeSetupToken('https://innocent.example.com/claim/x', { lookup: dnsTable({ 'innocent.example.com': ['169.254.169.254'] }) }),
    code('invalid_token'),
    'a name fronting the metadata endpoint'
  );
});

test('ANY private result rejects the whole host — mixed answers are the rebinding shape', async () => {
  await assert.rejects(
    () => decodeSetupToken(b64('https://dual.example.com/claim/x'), { lookup: dnsTable({ 'dual.example.com': ['8.8.8.8', '192.168.1.9'] }) }),
    code('invalid_token')
  );
  // A private AAAA hiding behind a public A must reject too.
  await assert.rejects(
    () => decodeSetupToken(b64('https://dual6.example.com/claim/x'), { lookup: dnsTable({ 'dual6.example.com': ['8.8.8.8', 'fd00::1'] }) }),
    code('invalid_token')
  );
});

test('a public name resolving only to public addresses passes, v4 and v6', async () => {
  const r = await decodeSetupToken(b64('https://bridge.simplefin.org/claim/x'), {
    lookup: dnsTable({ 'bridge.simplefin.org': ['151.101.1.140', '2606:4700::6810:84e5'] }),
  });
  assert.equal(r.kind, 'claim');
});

test('a lookup failure is a clean SimpleFinError, never an unhandled rejection', async () => {
  // This same path runs inside sync pulls — a genuinely-dead host must land in
  // the ordinary error handling (last_error), so the shape matters.
  await assert.rejects(() => decodeSetupToken(b64('https://gone.example.com/claim/x'), { lookup: neverDns }), code('dns_failed'));
  // An empty answer set is a resolution failure too, not a pass.
  await assert.rejects(
    () => decodeSetupToken(b64('https://empty.example.com/claim/x'), { lookup: async () => [] }),
    code('dns_failed')
  );
});

// --- isPrivateIp range audit -------------------------------------------------

test('isPrivateIp: the shared classifier covers the full reserved table', () => {
  const priv = [
    '0.0.0.1', '10.255.255.255', '100.64.0.0', '100.127.255.255', '127.0.0.53',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.170', '192.0.2.1',
    '192.88.99.1', '192.168.0.1', '198.18.0.1', '198.19.255.255', '198.51.100.7',
    '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::8.8.8.8',
    '64:ff9b:1::1', 'fc00::1', 'fdab::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1',
    '2001:db8::1', '2002:a00:1::', 'ff02::1',
  ];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `${ip} must classify private`);

  const pub = [
    '8.8.8.8', '93.184.216.34',
    '100.63.255.255', '100.128.0.0', // both sides of the CGN /10
    '172.15.0.1', '172.32.0.1', // both sides of 172.16/12
    '192.0.1.1', '192.169.0.1', '198.17.0.1', '198.20.0.1',
    '2600::1', '2606:4700::6810:84e5', '2001:db9::1', // just past 2001:db8::/32
  ];
  for (const ip of pub) assert.equal(isPrivateIp(ip), false, `${ip} must classify public`);

  // Not IPs at all → null (a NAME; the caller resolves it instead).
  for (const s of ['example.com', '', '999.1.1.1', '1.2.3', 'fe80:zz::1', '1::2::3']) {
    assert.equal(isPrivateIp(s), null, `${s} is not an IP`);
  }
});

// --- splitAccessUrl ----------------------------------------------------------

test('credentials move into an Authorization header, percent-decoded; /accounts and slashes strip', async () => {
  const r = await splitAccessUrl('https://us%40er:pa%3Ass@bridge.example.com/simplefin/accounts', { lookup: publicDns });
  assert.equal(r.base, 'https://bridge.example.com/simplefin');
  assert.equal(r.authorization, `Basic ${Buffer.from('us@er:pa:ss').toString('base64')}`);

  const slash = await splitAccessUrl('https://u:p@bridge.example.com/simplefin/', { lookup: publicDns });
  assert.equal(slash.base, 'https://bridge.example.com/simplefin');
});

test('no credentials → null authorization; non-https and garbage rejected before DNS', async () => {
  assert.equal((await splitAccessUrl('https://bridge.example.com/simplefin', { lookup: publicDns })).authorization, null);
  await assert.rejects(
    () => splitAccessUrl('http://u:p@bridge.example.com/simplefin', { lookup: neverDns }),
    code('invalid_access_url')
  );
  await assert.rejects(() => splitAccessUrl('not a url', { lookup: neverDns }), code('invalid_access_url'));
});

test('a stored access URL pointing somewhere private is rejected on every pull', async () => {
  // As a literal…
  await assert.rejects(() => splitAccessUrl('https://u:p@10.0.0.5/simplefin', { lookup: neverDns }), code('invalid_token'));
  // …and as a name whose DNS answer is private — same verdict, resolved fresh
  // each pull, so a record that flips private later is still caught.
  await assert.rejects(
    () => splitAccessUrl('https://u:p@bridge.example.com/simplefin', { lookup: dnsTable({ 'bridge.example.com': ['172.17.0.2'] }) }),
    code('invalid_token')
  );
  // A dead host fails clean — sync records it in last_error and holds the
  // watermark, rather than an unhandled rejection killing the pull mid-flight.
  await assert.rejects(() => splitAccessUrl('https://u:p@gone.example.com/simplefin', { lookup: neverDns }), code('dns_failed'));
});

// --- claimAccessUrl with a stubbed fetch -------------------------------------

const ACCESS_URL = 'https://u:p@bridge.example.com/simplefin';

function withFetchStub(script, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = typeof script === 'function' ? script(String(url), init, calls.length) : script[calls.length - 1];
    if (!r) throw new Error(`fetch stub: no scripted response for call ${calls.length}`);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: name => (r.headers || {})[String(name).toLowerCase()] ?? null },
      text: async () => r.body ?? '',
    };
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => {
      globalThis.fetch = original;
    });
}

test('a successful claim POSTs once and returns the access-URL body, trimmed', () =>
  withFetchStub([{ status: 200, body: `${ACCESS_URL}\n` }], async calls => {
    const url = await claimAccessUrl('https://bridge.example.com/claim/x', { lookup: publicDns });
    assert.equal(url, ACCESS_URL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'manual', 'redirects must be handled by hand');
  }));

test('a 403 maps to token_already_claimed', () =>
  withFetchStub([{ status: 403, body: 'used' }], async () => {
    await assert.rejects(
      () => claimAccessUrl('https://bridge.example.com/claim/x', { lookup: publicDns }),
      code('token_already_claimed')
    );
  }));

test('a claim URL whose host fails DNS is refused BEFORE any request goes out', () =>
  withFetchStub([{ status: 200, body: ACCESS_URL }], async calls => {
    await assert.rejects(
      () => claimAccessUrl('https://gone.example.com/claim/x', { lookup: neverDns }),
      code('dns_failed')
    );
    assert.equal(calls.length, 0, 'the hop-0 check runs before the first fetch');
  }));

test('a 302 to a PRIVATE literal throws before any second request', () =>
  withFetchStub(
    [{ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }],
    async calls => {
      await assert.rejects(
        () => claimAccessUrl('https://bridge.example.com/claim/x', { lookup: publicDns }),
        code('invalid_token')
      );
      assert.equal(calls.length, 1, 'the metadata endpoint is never contacted');
    }
  ));

test('a redirect to a public NAME that resolves private throws before the second request', () =>
  withFetchStub(
    [{ status: 307, headers: { location: 'https://evil.example.com/claim/x' } }],
    async calls => {
      await assert.rejects(
        () =>
          claimAccessUrl('https://bridge.example.com/claim/x', {
            lookup: dnsTable({ 'bridge.example.com': ['93.184.216.34'], 'evil.example.com': ['10.0.0.5'] }),
          }),
        code('invalid_token')
      );
      assert.equal(calls.length, 1, 'the per-hop check re-resolves, not just re-pattern-matches');
    }
  ));

test('a 302 to an INSECURE URL throws insecure_redirect', () =>
  withFetchStub(
    [{ status: 302, headers: { location: 'http://bridge.example.com/claim/x' } }],
    async () => {
      await assert.rejects(
        () => claimAccessUrl('https://bridge.example.com/claim/x', { lookup: publicDns }),
        code('insecure_redirect')
      );
    }
  ));

test('a 302 on a POST refuses (a replayed GET would burn the single-use token)', () =>
  withFetchStub(
    [{ status: 302, headers: { location: 'https://elsewhere.example.com/claim/x' } }],
    async calls => {
      await assert.rejects(
        () => claimAccessUrl('https://bridge.example.com/claim/x', { lookup: publicDns }),
        code('claim_failed')
      );
      assert.equal(calls.length, 1);
    }
  ));

test('a 307 re-POSTs to the new URL and succeeds', () =>
  withFetchStub(
    [
      { status: 307, headers: { location: 'https://bridge2.example.com/claim/x' } },
      { status: 200, body: ACCESS_URL },
    ],
    async calls => {
      assert.equal(await claimAccessUrl('https://bridge.example.com/claim/x', { lookup: publicDns }), ACCESS_URL);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, 'https://bridge2.example.com/claim/x');
      assert.equal(calls[1].init.method, 'POST', 'a 307 preserves the method');
    }
  ));

test('more than 3 redirect hops throws too_many_redirects', () =>
  withFetchStub(
    (url, init, n) => ({ status: 307, headers: { location: `https://hop${n}.example.com/claim` } }),
    async calls => {
      await assert.rejects(
        () => claimAccessUrl('https://bridge.example.com/claim/x', { lookup: publicDns }),
        code('too_many_redirects')
      );
      assert.equal(calls.length, 4, '3 hops allowed, the 4th redirect is refused');
    }
  ));

test('a claim body that is not a credentialed https URL is refused', () =>
  withFetchStub(
    [
      { status: 200, body: 'OK' },
      { status: 200, body: 'https://bridge.example.com/simplefin' }, // no credentials
      { status: 200, body: 'https://u:p@10.0.0.5/simplefin' }, // private host
    ],
    async calls => {
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/a', { lookup: publicDns }), code('claim_failed'));
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/b', { lookup: publicDns }), code('claim_failed'));
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/c', { lookup: publicDns }), code('invalid_token'));
      assert.equal(calls.length, 3);
    }
  ));
