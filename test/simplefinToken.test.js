// SimpleFIN token/SSRF plumbing (api/_lib/simplefin.js) — a security surface
// backed by two CLAUDE.md Gotchas, previously untested:
//   • the setup token is user-supplied and the server POSTs to whatever it
//     decodes to, so private-address targets must be rejected;
//   • plain fetch follows redirects, which would walk straight past the check
//     — a public claim URL can 302 to the cloud metadata endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeSetupToken,
  splitAccessUrl,
  claimAccessUrl,
  SimpleFinError,
} from '../api/_lib/simplefin.js';

const code = expected => err => {
  assert.ok(err instanceof SimpleFinError, `expected SimpleFinError, got ${err}`);
  assert.equal(err.code, expected);
  return true;
};

// --- decodeSetupToken --------------------------------------------------------

const CLAIM_URL = 'https://bridge.simplefin.org/simplefin/claim/DEMO123';
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

test('a valid setup token decodes to its claim URL', () => {
  assert.deepEqual(decodeSetupToken(b64(CLAIM_URL)), { kind: 'claim', url: CLAIM_URL });
});

test('whitespace, newlines, URL-safe base64 and missing padding are tolerated', () => {
  const tok = b64(CLAIM_URL);
  const sloppy = `  ${tok.slice(0, 12)}\n${tok.slice(12)}  \n`;
  assert.equal(decodeSetupToken(sloppy).url, CLAIM_URL);

  // A URL crafted to produce + and / in its base64, then URL-safe-encoded
  // with the padding stripped.
  const gnarly = 'https://bridge.simplefin.org/claim/??~~>>';
  const urlSafe = b64(gnarly).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.ok(/[-_]/.test(urlSafe), 'fixture sanity: the token actually exercises URL-safe chars');
  assert.equal(decodeSetupToken(urlSafe).url, gnarly);
});

test('a pasted access URL is recognized as such (credentials present)', () => {
  const r = decodeSetupToken('https://u:p@bridge.example.com/simplefin');
  assert.equal(r.kind, 'access');
  const c = decodeSetupToken('https://bridge.example.com/simplefin/claim/x');
  assert.equal(c.kind, 'claim');
});

test('http targets are rejected, pasted or decoded', () => {
  assert.throws(() => decodeSetupToken('http://bridge.example.com/claim/x'), code('invalid_token'));
  assert.throws(() => decodeSetupToken(b64('http://bridge.example.com/claim/x')), code('invalid_token'));
});

test('private-network targets are rejected — including metadata, loopback and mapped-IPv4', () => {
  for (const target of [
    'https://169.254.169.254/latest/meta-data', // cloud metadata
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://localhost/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://192.168.1.5/x',
    'https://172.16.0.9/x',
    'https://[fd00::1]/x', // unique-local
    'https://[fe80::1]/x', // link-local
    'https://backend.internal/x',
    'https://mybox.local/x',
  ]) {
    assert.throws(() => decodeSetupToken(b64(target)), code('invalid_token'), target);
    assert.throws(() => decodeSetupToken(target), code('invalid_token'), `pasted: ${target}`);
  }
});

test('REGRESSION: public hosts that merely LOOK bank-internal are NOT blocked', () => {
  // The IPv6 patterns require the bracket a URL hostname always carries, so
  // ordinary names starting with the same letters must pass.
  for (const target of [
    'https://fdic.gov/x',
    'https://fcu-bridge.example.com/claim',
    'https://fe80cafe.example.com/x',
    'https://internal-tools.example.com/x', // "internal" not as a TLD
    'https://localhost.example.com/x', // "localhost" not as the whole host
  ]) {
    assert.equal(decodeSetupToken(b64(target)).url, target, target);
  }
});

test('empty and undecodable input → invalid_token', () => {
  assert.throws(() => decodeSetupToken(''), code('invalid_token'));
  assert.throws(() => decodeSetupToken('   '), code('invalid_token'));
  assert.throws(() => decodeSetupToken('%%%%not-base64%%%%'), code('invalid_token'));
});

// --- splitAccessUrl ----------------------------------------------------------

test('credentials move into an Authorization header, percent-decoded; /accounts and slashes strip', () => {
  const r = splitAccessUrl('https://us%40er:pa%3Ass@bridge.example.com/simplefin/accounts');
  assert.equal(r.base, 'https://bridge.example.com/simplefin');
  assert.equal(r.authorization, `Basic ${Buffer.from('us@er:pa:ss').toString('base64')}`);

  const slash = splitAccessUrl('https://u:p@bridge.example.com/simplefin/');
  assert.equal(slash.base, 'https://bridge.example.com/simplefin');
});

test('no credentials → null authorization; non-https and garbage rejected', () => {
  assert.equal(splitAccessUrl('https://bridge.example.com/simplefin').authorization, null);
  assert.throws(() => splitAccessUrl('http://u:p@bridge.example.com/simplefin'), code('invalid_access_url'));
  assert.throws(() => splitAccessUrl('not a url'), code('invalid_access_url'));
});

test('a stored access URL pointing somewhere private is rejected on every pull', () => {
  assert.throws(() => splitAccessUrl('https://u:p@10.0.0.5/simplefin'), code('invalid_token'));
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
    const url = await claimAccessUrl('https://bridge.example.com/claim/x');
    assert.equal(url, ACCESS_URL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'manual', 'redirects must be handled by hand');
  }));

test('a 403 maps to token_already_claimed', () =>
  withFetchStub([{ status: 403, body: 'used' }], async () => {
    await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/x'), code('token_already_claimed'));
  }));

test('a 302 to a PRIVATE host throws before any second request', () =>
  withFetchStub(
    [{ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }],
    async calls => {
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/x'), code('invalid_token'));
      assert.equal(calls.length, 1, 'the metadata endpoint is never contacted');
    }
  ));

test('a 302 to an INSECURE URL throws insecure_redirect', () =>
  withFetchStub(
    [{ status: 302, headers: { location: 'http://bridge.example.com/claim/x' } }],
    async () => {
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/x'), code('insecure_redirect'));
    }
  ));

test('a 302 on a POST refuses (a replayed GET would burn the single-use token)', () =>
  withFetchStub(
    [{ status: 302, headers: { location: 'https://elsewhere.example.com/claim/x' } }],
    async calls => {
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/x'), code('claim_failed'));
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
      assert.equal(await claimAccessUrl('https://bridge.example.com/claim/x'), ACCESS_URL);
      assert.equal(calls.length, 2);
      assert.equal(calls[1].url, 'https://bridge2.example.com/claim/x');
      assert.equal(calls[1].init.method, 'POST', 'a 307 preserves the method');
    }
  ));

test('more than 3 redirect hops throws too_many_redirects', () =>
  withFetchStub(
    (url, init, n) => ({ status: 307, headers: { location: `https://hop${n}.example.com/claim` } }),
    async calls => {
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/x'), code('too_many_redirects'));
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
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/a'), code('claim_failed'));
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/b'), code('claim_failed'));
      await assert.rejects(() => claimAccessUrl('https://bridge.example.com/claim/c'), code('invalid_token'));
      assert.equal(calls.length, 3);
    }
  ));
