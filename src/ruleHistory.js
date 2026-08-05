// Applying a learned merchant rule to HISTORY, extracted pure-ish: all the
// real logic — first-token ilike narrowing, ordered paging with the PGRST103
// end-of-range contract, re-matching via matchLearnedRule, skip-already-
// correct, dryRun — takes a page-fetch function and a batch-update function
// instead of the Supabase client, so it is testable with fakes.
// dataAdapter.js wraps it with the real client (applyCategoryRuleToHistory).

import { merchantKey, matchLearnedRule } from './txClassify.js';

// PostgREST answers a Range whose start is past the last row with 416
// ("Requested range not satisfiable", PGRST103). That is end-of-data, not a
// failure, and a paging loop that treats it as one dies on any result set
// whose size is an exact multiple of the page.
export function isRangeExhaustedError(error) {
  if (!error) return false;
  return error.code === 'PGRST103' || /range not satisfiable/i.test(error.message || '');
}

// The server-side candidate narrowing: ilike on the key's first token. The
// escape is belt-and-braces — through the real entry point a descriptor can
// never inject ilike wildcards, because merchantKey strips non-token
// characters before this pattern is built — but a crafted key passed directly
// must still not wildcard-match unrelated rows.
export function ilikeCandidatePattern(key) {
  const firstToken = String(key).split(' ')[0];
  return `%${firstToken.replace(/([\\%_])/g, '\\$1')}%`;
}

// Apply `descriptor → category` to historical rows.
//
//   fetchPage(pattern, from, to) → { data, error } — a page of candidate rows
//     ({ id, description, merchant_name, mapped_category, amount }), ordered by id
//     ascending (paging an unordered result set can drop or repeat rows
//     across the boundary, and a dropped row here is a transaction the rule
//     silently fails to fix). May answer an out-of-range request with the
//     PGRST103 error shape, exactly like PostgREST.
//   updateBatch(ids, category) → { error } — write mapped_category ONLY for
//     those ids. mapped_category only, so a per-transaction user_category
//     override always still wins at read time — this changes what the
//     classifier *would* have said, not what the user decided.
//
// Returns the number of rows a wet run writes (dryRun counts the same set).
// ALWAYS throws on a real failure and never returns 0 to mean "it didn't
// work" — 0 genuinely means nothing matched, and callers render the two very
// differently (see the dataAdapter comment on the silent-failure incident).
//
// `amount` (optional) scopes the rule to transactions of exactly that amount,
// in the app convention (positive = money out). It is threaded into the
// re-match as the RULE's amount while the ROW's own amount is what it is
// compared against, so an amount-scoped rule rewrites only the rows it would
// actually classify. `amount` null/undefined is the any-amount rule and
// behaves exactly as before. This is why fetchPage must select `amount`:
// without it every row's amount reads undefined and a scoped rule matches
// nothing at all — silently, which would look like "the rule is fine, there
// is just no history".
//
// `countAll` answers a DIFFERENT question: how many rows does this rule match
// AT ALL, whatever they are currently categorized as. dryRun counts only rows
// the rule would still CHANGE, so a healthy, already-applied rule counts 0 —
// fine as "nothing left to update", ruinous as "this rule matches nothing",
// which is how the Taught-rules list would talk a human into deleting a rule
// that is working perfectly. countAll therefore drops the
// `mapped_category !== category` clause and never writes.
export async function applyRuleToHistory({
  descriptor,
  category,
  amount = null,
  dryRun = false,
  countAll = false,
  fetchPage,
  updateBatch,
  pageSize = 1000,
  batchSize = 200,
}) {
  const key = merchantKey(descriptor);
  if (!key) return 0;

  // The match is on the NORMALIZED descriptor, which SQL can't reproduce, so
  // candidates are narrowed server-side with ilike on the first token and the
  // exact rule applied here.
  const pat = ilikeCandidatePattern(key);

  const matches = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(pat, from, from + pageSize - 1);
    // Asking for a page that starts past the end is PostgREST's 416, which
    // supabase-js reports as an error — but it just means "no more rows", and
    // it happens whenever the match count is an exact multiple of the page.
    if (error && isRangeExhaustedError(error)) break;
    if (error) throw error;
    for (const t of data) {
      // Classify on the same string the write path uses.
      const descriptors = [t.merchant_name, t.description].filter(Boolean);
      // The rules bag carries the entry shape txClassify understands, and the
      // ROW's amount is what the scoped rule is tested against.
      const bag = { [key]: [{ amount: amount == null ? null : Number(amount), category }] };
      const rowAmount = typeof t.amount === 'number' ? t.amount : Number(t.amount);
      const hit = descriptors.some(d => matchLearnedRule(d, bag, rowAmount));
      if (hit && (countAll || t.mapped_category !== category)) matches.push(t.id);
    }
    if (data.length < pageSize) break;
  }
  if (countAll || dryRun || matches.length === 0) return matches.length;

  for (let i = 0; i < matches.length; i += batchSize) {
    const { error } = await updateBatch(matches.slice(i, i + batchSize), category);
    if (error) throw error;
  }
  return matches.length;
}
