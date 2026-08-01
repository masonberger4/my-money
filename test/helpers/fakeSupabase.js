// In-memory Supabase (service-role PostgREST) fake for the api/sync.js
// orchestration tests — built in the ruleHistory.js fake-PostgREST spirit:
// implement ONLY the chains the code under test actually uses, but implement
// them with the real contract (filter semantics, upsert conflict behavior,
// PostgREST's actual error shapes), and record every write for assertions.
//
// Chains api/sync.js uses on the pullOneAccessUrl path (grep-verified
// 2026-08-01 — .is/.lt/.delete/.single/.maybeSingle are NOT among them):
//   from(t).select(cols).eq(col, v).not(col, 'is', null)       institutions read
//   from(t).select(cols).eq(col, v).like(col, pattern)         accounts reads
//   from(t).insert(rows).select(cols)                          institutions create
//   from(t).update(patch).eq(col, v)[.or(arms)][.select(cols)] throttle stamp / account patch / watermark
//   from(t).update(patch).in(col, vals)                        institution bookkeeping
//   from(t).upsert(rows, { onConflict[, ignoreDuplicates] })   accounts / transactions / balance_snapshots
//
// Anything else throws, loudly — a chain this fake doesn't know is a chain the
// production code grew after this file was written, and a silent no-op here
// would let the orchestration tests pass while testing nothing.
//
// Two degrade knobs mirror the shared-prod-database reality the sync must
// survive (previews deploy before Mason pastes their migration):
//   missingTables:  every operation answers PGRST205, the shape
//                   isMissingTableError matches.
//   missingColumns: a write whose payload NAMES the column answers PGRST204
//                   naming it, the shape isMissingColumnError matches. Reads
//                   and writes that don't touch the column succeed — exactly
//                   how PostgREST behaves for a column absent from the cache.

export function pgMissingTableError(table) {
  return {
    code: 'PGRST205',
    message: `Could not find the table 'public.${table}' in the schema cache`,
    details: null,
    hint: null,
  };
}

export function pgMissingColumnError(table, column) {
  return {
    code: 'PGRST204',
    message: `Could not find the '${column}' column of '${table}' in the schema cache`,
    details: null,
    hint: null,
  };
}

const snap = value => JSON.parse(JSON.stringify(value ?? null));

function likeToRegex(pattern) {
  let out = '';
  for (const c of String(pattern)) {
    if (c === '%') out += '[\\s\\S]*';
    else if (c === '_') out += '.';
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  // LIKE, not ILIKE — case-sensitive, matching Postgres.
  return new RegExp(`^${out}$`);
}

// One arm of PostgREST's or= grammar, e.g. "last_attempt_at.lt.2026-…Z".
// The VALUE may itself contain dots (ISO timestamps do), so only the first two
// dots delimit — the same reason attemptThrottleFilter must never emit a comma.
function parseOrArm(arm) {
  const i = arm.indexOf('.');
  const j = arm.indexOf('.', i + 1);
  if (i < 0 || j < 0) throw new Error(`fakeSupabase: unparseable or= arm "${arm}"`);
  return { col: arm.slice(0, i), op: arm.slice(i + 1, j), value: arm.slice(j + 1) };
}

function armMatches(row, { col, op, value }) {
  if (op === 'is' && value === 'null') return row[col] == null;
  // ISO-8601 strings compare correctly as strings; that is the only value type
  // sync.js sends through .or() (see attemptThrottleFilter's comma-free rule).
  if (op === 'lt') return row[col] != null && String(row[col]) < value;
  throw new Error(`fakeSupabase: unsupported or= operator "${op}"`);
}

function rowMatches(row, filter) {
  switch (filter.kind) {
    case 'eq':
      return row[filter.col] === filter.value;
    case 'in':
      return filter.values.includes(row[filter.col]);
    case 'like':
      return filter.re.test(String(row[filter.col] ?? ''));
    case 'not-is-null':
      return row[filter.col] != null;
    case 'or':
      return filter.arms.some(arm => armMatches(row, arm));
    default:
      throw new Error(`fakeSupabase: unknown filter kind "${filter.kind}"`);
  }
}

function project(row, cols) {
  if (!cols || cols === '*') return { ...row };
  const out = {};
  for (const c of String(cols).split(',').map(s => s.trim()).filter(Boolean)) {
    out[c] = row[c] === undefined ? null : row[c];
  }
  return out;
}

export function makeFakeSupabase(seed = {}, opts = {}) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, rows.map(r => ({ ...r }))]));
  const missingTables = new Set(opts.missingTables || []);
  const missingColumns = opts.missingColumns || {}; // { table: ['col', …] }

  // Every WRITE attempt in order, including failed ones:
  //   { table, op, payload|patch, options?, filters?, matched?/inserted?/updated?/skippedRows?, error? }
  const writes = [];
  // Coarse ordered event log ('select:accounts', 'update:simplefin_access', …).
  // Tests push their own 'fetch' markers into it to assert write-vs-request
  // ordering (the stamp-before-request rule).
  const events = [];

  let idCounter = 1;
  const genId = table => `${table.slice(0, 4)}-${idCounter++}`;
  const rowsOf = name => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.op = null;
      this.payload = null;
      this.options = {};
      this.cols = null;
      this.filters = [];
    }

    select(cols) {
      if (this.op == null) this.op = 'select';
      this.cols = cols ?? '*';
      return this;
    }
    insert(rows) {
      this.op = 'insert';
      this.payload = rows;
      return this;
    }
    update(patch) {
      this.op = 'update';
      this.payload = patch;
      return this;
    }
    upsert(rows, options = {}) {
      this.op = 'upsert';
      this.payload = rows;
      this.options = options;
      return this;
    }
    eq(col, value) {
      this.filters.push({ kind: 'eq', col, value });
      return this;
    }
    in(col, values) {
      this.filters.push({ kind: 'in', col, values: [...values] });
      return this;
    }
    like(col, pattern) {
      this.filters.push({ kind: 'like', col, re: likeToRegex(pattern) });
      return this;
    }
    not(col, op, value) {
      if (op !== 'is' || value !== null) {
        throw new Error("fakeSupabase: only .not(col, 'is', null) is implemented");
      }
      this.filters.push({ kind: 'not-is-null', col });
      return this;
    }
    or(expr) {
      this.filters.push({ kind: 'or', arms: String(expr).split(',').map(parseOrArm) });
      return this;
    }

    // supabase-js builders are thenables that resolve { data, error } and never
    // reject — errors ride in the object, which is exactly the contract the
    // degrade paths in api/sync.js depend on.
    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => this.#run())
        .then(onFulfilled, onRejected);
    }

    #run() {
      events.push(`${this.op}:${this.table}`);
      const record = extra => writes.push({ table: this.table, op: this.op, ...extra });

      if (missingTables.has(this.table)) {
        const error = pgMissingTableError(this.table);
        if (this.op !== 'select') record({ payload: snap(this.payload), options: { ...this.options }, error });
        return { data: null, error };
      }

      const rows = rowsOf(this.table);
      const badCols = missingColumns[this.table] || [];
      const findBadColumn = obj =>
        badCols.find(c => obj != null && Object.prototype.hasOwnProperty.call(obj, c));

      if (this.op === 'select') {
        const data = rows.filter(r => this.filters.every(f => rowMatches(r, f))).map(r => project(r, this.cols));
        return { data, error: null };
      }

      if (this.op === 'update') {
        const bad = findBadColumn(this.payload);
        if (bad) {
          const error = pgMissingColumnError(this.table, bad);
          record({ patch: snap(this.payload), filters: this.filters.length, error });
          return { data: null, error };
        }
        const matched = rows.filter(r => this.filters.every(f => rowMatches(r, f)));
        for (const r of matched) Object.assign(r, this.payload);
        record({ patch: snap(this.payload), filters: this.filters.length, matched: matched.length });
        return { data: this.cols ? matched.map(r => project(r, this.cols)) : null, error: null };
      }

      if (this.op === 'insert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const bad = list.map(findBadColumn).find(Boolean);
        if (bad) {
          const error = pgMissingColumnError(this.table, bad);
          record({ payload: snap(list), error });
          return { data: null, error };
        }
        const inserted = list.map(r => ({ id: r.id ?? genId(this.table), ...r }));
        rows.push(...inserted);
        record({ payload: snap(list), inserted: inserted.length });
        return { data: this.cols ? inserted.map(r => project(r, this.cols)) : null, error: null };
      }

      if (this.op === 'upsert') {
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        const conflictCols = String(this.options.onConflict || '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
        if (!conflictCols.length) {
          throw new Error('fakeSupabase: upsert without onConflict is not implemented');
        }
        const bad = list.map(findBadColumn).find(Boolean);
        if (bad) {
          const error = pgMissingColumnError(this.table, bad);
          record({ payload: snap(list), options: { ...this.options }, error });
          return { data: null, error };
        }
        const keyOf = r => conflictCols.map(c => String(r[c])).join('');
        // Postgres semantics, the reason the seenAccount/seenTx dedup sets in
        // api/sync.js exist: an INSERT … ON CONFLICT DO UPDATE whose payload
        // hits the same row twice aborts the whole statement; DO NOTHING
        // (ignoreDuplicates) merely skips the second copy.
        if (!this.options.ignoreDuplicates) {
          const seen = new Set();
          for (const r of list) {
            const k = keyOf(r);
            if (seen.has(k)) {
              const error = {
                code: '21000',
                message: 'ON CONFLICT DO UPDATE command cannot affect row a second time',
                details: null,
                hint: 'Ensure that no rows proposed for insertion within the same command have duplicate constrained values.',
              };
              record({ payload: snap(list), options: { ...this.options }, error });
              return { data: null, error };
            }
            seen.add(k);
          }
        }
        const seenInPayload = new Set();
        let inserted = 0;
        let updated = 0;
        let skippedRows = 0;
        for (const r of list) {
          const k = keyOf(r);
          if (seenInPayload.has(k)) {
            skippedRows++; // only reachable under ignoreDuplicates (DO NOTHING)
            continue;
          }
          seenInPayload.add(k);
          const existing = rows.find(row => conflictCols.every(c => row[c] === r[c]));
          if (existing) {
            if (this.options.ignoreDuplicates) skippedRows++;
            else {
              Object.assign(existing, r);
              updated++;
            }
          } else {
            rows.push({ id: r.id ?? genId(this.table), ...r });
            inserted++;
          }
        }
        record({ payload: snap(list), options: { ...this.options }, inserted, updated, skippedRows });
        return { data: null, error: null };
      }

      throw new Error(`fakeSupabase: unsupported operation "${this.op}"`);
    }
  }

  return {
    client: { from: table => new Query(table) },
    tables,
    rows: rowsOf,
    writes,
    events,
  };
}
