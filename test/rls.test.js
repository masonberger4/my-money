// RLS policy harness — the only test that talks to a real Postgres.
//
// WHAT IT DOES
//   Stands up a THROWAWAY Postgres cluster in a temp dir, applies
//   test/fixtures/rls_stub.sql (the CLAUDE.md "Local checks" stub: auth schema,
//   auth.users, auth.uid() reading request.jwt.claims.sub, the three roles, a
//   minimal storage schema, publication supabase_realtime), then every file in
//   supabase/migrations/ in filename order, then runs
//   test/fixtures/rls_assert.sql, which impersonates `authenticated` (set role +
//   set_config('request.jwt.claims')) for household A and asserts:
//     - cross-household SELECT / INSERT / UPDATE / DELETE denied on
//       transactions, accounts, settings, expected_transactions (+ institutions)
//     - simplefin_access is invisible to `authenticated` (zero client policies)
//     - household_id defaults resolve for a client-role insert
//   Any violation raises inside the SQL, psql exits non-zero, the test fails
//   with the raised message.
//
// WHEN IT SKIPS (never fails, never hangs)
//   If psql / initdb / pg_ctl aren't on the machine, or the cluster can't be
//   started within the timeouts, the test SKIPS with a message saying why.
//   Set RLS_SKIP=1 to skip unconditionally.
//
// RUN RECIPE (local dev)
//   Needs a Postgres 16 client+server install; nothing else, no npm deps.
//     macOS:  brew install postgresql@16   (then: brew link --force postgresql@16)
//     Debian: sudo apt-get install postgresql-16
//   Then just:  npm test          (or: node --test test/rls.test.js)
//   Point PG_BINDIR at the bin/ dir if initdb isn't on PATH:
//     PG_BINDIR=/usr/lib/postgresql/16/bin node --test test/rls.test.js
//   initdb refuses to run as root; when the test runs as root it re-runs the
//   cluster commands via `su postgres -c`, which is why it works in CI images.
//   After changing a migration or a policy, re-run this — it is the only check
//   that reads the policies as the database actually enforces them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const STUB = path.join(HERE, 'fixtures', 'rls_stub.sql');
const ASSERT_SQL = path.join(HERE, 'fixtures', 'rls_assert.sql');

const PORT = 55400 + (process.pid % 120); // avoid colliding with a real server
const SPAWN_MS = 30000; // hard timeout on every child process

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function findBindir() {
  if (process.env.PG_BINDIR) return process.env.PG_BINDIR;
  const onPath = which('initdb');
  if (onPath) return path.dirname(onPath);
  for (const glob of ['/usr/lib/postgresql', '/usr/local/opt', '/opt/homebrew/opt']) {
    let entries = [];
    try { entries = fs.readdirSync(glob); } catch { continue; }
    for (const e of entries.sort().reverse()) {
      const bin = path.join(glob, e, 'bin');
      if (fs.existsSync(path.join(bin, 'initdb'))) return bin;
    }
  }
  return null;
}

// Running as root, initdb/pg_ctl must be dropped to an unprivileged user.
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const suUser = isRoot && spawnSync('id', ['postgres'], { timeout: 5000 }).status === 0
  ? 'postgres'
  : null;

function run(cmd, { env = {}, cwd } = {}) {
  const [bin, ...args] = suUser ? ['su', suUser, '-c', cmd] : ['sh', '-c', cmd];
  return spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: SPAWN_MS,
    killSignal: 'SIGKILL',
    cwd,
    env: { ...process.env, ...env },
  });
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

test('RLS policies: cross-household access denied (needs local Postgres)', async (t) => {
  if (process.env.RLS_SKIP === '1') {
    t.skip('RLS_SKIP=1 set');
    return;
  }
  const bindir = findBindir();
  if (!bindir || !fs.existsSync(path.join(bindir, 'psql'))) {
    t.skip('no local Postgres found (need initdb/pg_ctl/psql; see the header for the install recipe). Set PG_BINDIR to point at them.');
    return;
  }
  if (isRoot && !suUser) {
    t.skip('running as root with no unprivileged `postgres` user to drop to; initdb refuses to run as root');
    return;
  }

  let dir = null;
  let started = false;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rls-'));
    fs.chmodSync(dir, 0o777);
    if (suUser) {
      const r = run(`true`, {});
      if (r.status !== 0) { t.skip('cannot drop privileges to the postgres user'); return; }
      spawnSync('chown', ['-R', suUser, dir], { timeout: 10000 });
      spawnSync('chmod', ['700', dir], { timeout: 10000 });
    }
    const data = path.join(dir, 'data');

    const init = run(`${shq(path.join(bindir, 'initdb'))} -D ${shq(data)} -U postgres --auth=trust -E UTF8`);
    if (init.status !== 0) {
      t.skip(`initdb failed, skipping RLS harness: ${(init.stderr || init.error?.message || '').slice(0, 300)}`);
      return;
    }

    const opts = `-k ${dir} -p ${PORT} -c listen_addresses= -c fsync=off -c full_page_writes=off`;
    const up = run(`${shq(path.join(bindir, 'pg_ctl'))} -D ${shq(data)} -o ${shq(opts)} -l ${shq(path.join(dir, 'log'))} -w -t 25 start`);
    if (up.status !== 0) {
      t.skip(`could not start the temp cluster, skipping RLS harness: ${(up.stderr || up.error?.message || '').slice(0, 300)}`);
      return;
    }
    started = true;

    const psql = shq(path.join(bindir, 'psql'));
    const conn = `-h ${dir} -p ${PORT} -U postgres`;
    const q = (sqlFile, db = 'rlstest') =>
      run(`${psql} ${conn} -d ${db} -q -v ON_ERROR_STOP=1 -f ${shq(sqlFile)}`);

    const created = run(`${psql} ${conn} -d postgres -q -v ON_ERROR_STOP=1 -c 'create database rlstest'`);
    if (created.status !== 0) {
      t.skip(`could not create the test database: ${(created.stderr || '').slice(0, 300)}`);
      return;
    }

    const stub = q(STUB);
    assert.equal(stub.status, 0, `stub SQL failed:\n${stub.stderr}`);

    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    assert.ok(files.length > 0, 'no migrations found');
    for (const f of files) {
      const r = q(path.join(MIGRATIONS, f));
      assert.equal(r.status, 0, `migration ${f} failed:\n${r.stderr}`);
    }

    const res = q(ASSERT_SQL);
    assert.equal(res.status, 0, `RLS assertion failed:\n${res.stderr}`);
    assert.match(res.stdout, /RLS_OK/, `RLS assertions did not reach the end:\n${res.stdout}`);
  } finally {
    if (started && dir) {
      run(`${shq(path.join(bindir, 'pg_ctl'))} -D ${shq(path.join(dir, 'data'))} -m immediate -w -t 15 stop`);
    }
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
});
