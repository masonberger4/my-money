import { getServiceClient, requireUser } from './_lib/supabase.js';
import {
  unlinkSettingsKey,
  visibleAccountIds,
  parseRestoreSet,
  restoreSet,
  isPermanentDeleteRequest,
  permanentDeleteAllowed,
} from './_lib/unlink.js';

// Record which accounts are VISIBLE right now, then hide them all. The record
// is what Restore replays, and recording only the visible ones is the whole
// point: an account the user hid deliberately before removing the bank must
// stay hidden afterwards, as must a new arrival (a SimpleFIN account arrives
// hidden because its type is a guess; a fresh statement import lands under the
// same "Imported" institution). Service_role means household_id must be
// explicit — the column default reads auth.uid(), NULL here (CLAUDE.md
// Gotchas). Returns how many accounts were hidden.
async function softHideInstitution(supabase, householdId, institutionId) {
  const { data: acctRows, error: readErr } = await supabase
    .from('accounts')
    .select('id, hidden')
    .eq('institution_id', institutionId);
  if (readErr) throw readErr;

  // NEVER overwrite an existing record. A second remove of an
  // already-removed institution sees every account hidden, so a fresh
  // snapshot would be `[]` — and an empty record reads exactly like NO
  // record, so the Restore offer would vanish permanently while the accounts
  // stayed hidden (review catch). The first removal's snapshot is the truth
  // about what was visible; a repeat remove is a no-op for the record.
  // Re-running the hide below is still correct and idempotent.
  const key = unlinkSettingsKey(institutionId);
  const { data: existing, error: existErr } = await supabase
    .from('settings')
    .select('key')
    .eq('household_id', householdId)
    .eq('key', key)
    .maybeSingle();
  if (existErr) throw existErr;

  if (!existing) {
    const { error: recordErr } = await supabase.from('settings').upsert(
      {
        household_id: householdId,
        key,
        value: JSON.stringify(visibleAccountIds(acctRows)),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'household_id,key' }
    );
    if (recordErr) throw recordErr;
  }

  const { error: hideErr } = await supabase
    .from('accounts')
    .update({ hidden: true })
    .eq('institution_id', institutionId);
  if (hideErr) throw hideErr;

  return acctRows?.length || 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  const { institution_id, restore_institution_id } = req.body || {};

  // Restore mode, MANUAL institutions only. The SimpleFIN restore lives in
  // api/simplefin-status.js because it must also clear the disabled tombstone
  // that keeps the org out of re-pulls; a manual institution has no tombstone
  // to clear (it is permanently disabled by design), so its removal is
  // recorded by the settings row alone and undone here.
  if (restore_institution_id) {
    try {
      const supabase = getServiceClient();
      const { data: inst, error: instErr } = await supabase
        .from('institutions')
        .select('id, name')
        .eq('id', restore_institution_id)
        .eq('household_id', user.householdId)
        .is('simplefin_org_id', null)
        .maybeSingle();
      if (instErr) throw instErr;
      if (!inst) {
        return res.status(404).json({ error: 'No such imported institution in this household' });
      }

      const key = unlinkSettingsKey(restore_institution_id);
      const { data: setting, error: setErr } = await supabase
        .from('settings')
        .select('value')
        .eq('household_id', user.householdId)
        .eq('key', key)
        .maybeSingle();
      if (setErr) throw setErr;

      let unhidden = 0;
      const recorded = parseRestoreSet(setting?.value);
      if (recorded.length) {
        const { data: acctRows, error: acctErr } = await supabase
          .from('accounts')
          .select('id')
          .eq('institution_id', restore_institution_id);
        if (acctErr) throw acctErr;
        const toUnhide = restoreSet(recorded, (acctRows || []).map(a => a.id));
        if (toUnhide.length) {
          const { data: updated, error: unhideErr } = await supabase
            .from('accounts')
            .update({ hidden: false })
            // .eq('hidden', true) so the count is rows CHANGED, not rows
            // matched: an account the user already unhid by hand must not be
            // counted as restored, or the alert overstates what happened and
            // contradicts the count the strip offered (review catch).
            .eq('hidden', true)
            .in('id', toUnhide)
            .select('id');
          if (unhideErr) throw unhideErr;
          unhidden = updated?.length ?? 0;
        }
      }

      // The record is consumed either way — a second Restore must not replay a
      // stale visibility snapshot over later user edits (the simplefin-status
      // rule). Consuming it is also what clears the "removed" marker.
      await supabase
        .from('settings')
        .delete()
        .eq('household_id', user.householdId)
        .eq('key', key);

      return res.status(200).json({ ok: true, restored: inst.name, unhidden });
    } catch (err) {
      console.error('unlink-institution restore error', err?.response?.data || err);
      return res
        .status(500)
        .json({ error: 'restore_failed', message: 'Restoring the imported accounts failed — try again.' });
    }
  }

  if (!institution_id) {
    return res.status(400).json({ error: 'institution_id required' });
  }

  // The buried permanent path must be asked for twice: { permanent: true,
  // confirm: 'delete' }. permanent without the literal confirm is rejected —
  // no client bug or fat-finger can cascade-delete a household's history.
  const permanent = isPermanentDeleteRequest(req.body);
  if (permanent && !permanentDeleteAllowed(req.body)) {
    return res
      .status(400)
      .json({ error: "Permanent delete requires confirm: 'delete'" });
  }

  try {
    const supabase = getServiceClient();
    let inst;
    let instErr;
    ({ data: inst, error: instErr } = await supabase
      .from('institutions')
      .select('id, name, household_id, simplefin_org_id')
      .eq('id', institution_id)
      .eq('household_id', user.householdId)
      .maybeSingle());
    // Tolerate a deploy that lands before the SimpleFIN migration.
    if (instErr && (instErr.code === 'PGRST204' || instErr.code === '42703')) {
      ({ data: inst, error: instErr } = await supabase
        .from('institutions')
        .select('id, name, household_id')
        .eq('id', institution_id)
        .eq('household_id', user.householdId)
        .maybeSingle());
    }
    if (instErr) throw instErr;
    if (!inst) {
      return res.status(404).json({ error: 'Institution not found' });
    }

    // SimpleFIN institutions can't be unlinked by deleting the row. One access
    // URL covers EVERY bank linked at the Bridge, so the very next pull would
    // find this org again and recreate it. Instead the DEFAULT remove is a
    // SOFT-HIDE: mark the accounts hidden (query-level exclusion from every
    // spending view) and keep the institution as a disabled tombstone —
    // api/sync.js skips disabled institutions, so the org stays out of the app
    // until the user restores it. NOTHING is deleted, so csv/pdf backfill rows
    // survive a mis-tap. The old cascade lives on only behind the explicit
    // { permanent: true, confirm: 'delete' } mode below. To stop the bank
    // feeding SimpleFIN at all, they remove it at SimpleFIN Bridge.
    if (inst.simplefin_org_id) {
      if (permanent) {
        // Real cleanup (closed accounts): delete accounts (cascades their
        // transactions) and keep the disabled tombstone — without it the next
        // pull would recreate the org. Also drop any recorded restore set.
        const { error: acctErr } = await supabase
          .from('accounts')
          .delete()
          .eq('institution_id', inst.id);
        if (acctErr) throw acctErr;

        await supabase
          .from('settings')
          .delete()
          .eq('household_id', user.householdId)
          .eq('key', unlinkSettingsKey(inst.id));

        const { error: disableErr } = await supabase
          .from('institutions')
          .update({ status: 'disabled', last_error: null, sync_state: {} })
          .eq('id', inst.id);
        if (disableErr) throw disableErr;

        return res.status(200).json({ ok: true, disabled: true, deleted: true });
      }

      const hiddenCount = await softHideInstitution(supabase, user.householdId, inst.id);

      const { error: disableErr } = await supabase
        .from('institutions')
        .update({ status: 'disabled', last_error: null, sync_state: {} })
        .eq('id', inst.id);
      if (disableErr) throw disableErr;

      return res.status(200).json({ ok: true, disabled: true, hidden: hiddenCount });
    }

    // Everything else is a MANUAL institution — the "Imported" row CSV/PDF
    // import creates. With Plaid gone that is the only other kind there is.
    //
    // Gated on the org id being ABSENT rather than merely falsy, which is not
    // pedantry: the permanent path below hard-deletes and cascades away every
    // account and transaction beneath it, and the branch above tests `if
    // (inst.simplefin_org_id)`. An empty-string org id — a shape we never write
    // but could read back from a hand-edited row — is falsy, so it would fall
    // past the SimpleFIN branch and be treated as manual by a route the user
    // pressed expecting a reversible disconnect. Unknown shapes stop here.
    const isManualInstitution = inst.simplefin_org_id === null || inst.simplefin_org_id === undefined;
    if (!isManualInstitution) {
      return res.status(400).json({ error: 'Unrecognised institution feed; refusing to delete' });
    }

    if (permanent) {
      // Real cleanup, behind the same { permanent: true, confirm: 'delete' }
      // literals as its SimpleFIN sibling (checked once, above). Cascades:
      // accounts, and their transactions. Unlike SimpleFIN there is no
      // tombstone to keep — nothing recreates a manual institution, so
      // deleting the row is the whole operation, and the restore record goes
      // with it (there is nothing left to restore).
      await supabase
        .from('settings')
        .delete()
        .eq('household_id', user.householdId)
        .eq('key', unlinkSettingsKey(inst.id));

      const { error: delErr } = await supabase
        .from('institutions')
        .delete()
        .eq('id', inst.id);
      if (delErr) throw delErr;

      return res.status(200).json({ ok: true, deleted: true });
    }

    // DEFAULT: soft-hide, same as SimpleFIN (Mason, 2026-08-13). Removing an
    // imported institution used to cascade-delete the household's entire
    // statement backfill — history rebuilt from files that live on Mason's
    // devices, not in the app — on a single confirm. Now nothing is deleted:
    // the accounts are hidden (query-excluded from every total) and the
    // visible-at-hide-time set is recorded for Restore.
    //
    // NOTE the asymmetry with the branch above, and don't "fix" it: a manual
    // institution is permanently `status='disabled'` (that status is what
    // keeps it out of every sync path — CLAUDE.md's feed discriminator), so
    // there is no tombstone to set here and status must be left ALONE. The
    // settings record IS the removed marker for manual institutions, which is
    // also what the Accounts tab reads to offer Restore.
    const hiddenCount = await softHideInstitution(supabase, user.householdId, inst.id);
    return res.status(200).json({ ok: true, hidden: hiddenCount });
  } catch (err) {
    // Log the full error server-side; never echo upstream bodies (a whole
    // PostgREST error object, schema details) to the client — generic string
    // + stable code only, the sanitizeFeedMessage discipline for the catch-all.
    console.error('unlink-institution error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: 'unlink_failed', message: 'Removing the bank failed — try again.' });
  }
}
