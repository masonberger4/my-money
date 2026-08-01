import { getServiceClient, requireUser } from './_lib/supabase.js';
import {
  unlinkSettingsKey,
  visibleAccountIds,
  isPermanentDeleteRequest,
  permanentDeleteAllowed,
} from './_lib/unlink.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const user = await requireUser(req, res);
  if (!user) return;

  const { institution_id } = req.body || {};
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

      // Record which accounts were VISIBLE right now, so Restore can unhide
      // exactly those — not the ones the user had already hidden on purpose,
      // and not future arrivals (which arrive hidden for a reason). Settings
      // table, no migration; service_role means household_id must be explicit
      // (the default reads auth.uid(), NULL here — see CLAUDE.md Gotchas).
      const { data: acctRows, error: readErr } = await supabase
        .from('accounts')
        .select('id, hidden')
        .eq('institution_id', inst.id);
      if (readErr) throw readErr;
      const visible = visibleAccountIds(acctRows);

      const { error: recordErr } = await supabase
        .from('settings')
        .upsert(
          {
            household_id: user.householdId,
            key: unlinkSettingsKey(inst.id),
            value: JSON.stringify(visible),
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'household_id,key' }
        );
      if (recordErr) throw recordErr;

      const { error: hideErr } = await supabase
        .from('accounts')
        .update({ hidden: true })
        .eq('institution_id', inst.id);
      if (hideErr) throw hideErr;

      const { error: disableErr } = await supabase
        .from('institutions')
        .update({ status: 'disabled', last_error: null, sync_state: {} })
        .eq('id', inst.id);
      if (disableErr) throw disableErr;

      return res.status(200).json({ ok: true, disabled: true, hidden: acctRows?.length || 0 });
    }

    // Everything else is a MANUAL institution — the "Imported" row CSV/PDF
    // import creates. With Plaid gone that is the only other kind there is.
    //
    // Gated on the org id being ABSENT rather than merely falsy, which is not
    // pedantry: this path hard-deletes and cascades away every account and
    // transaction beneath it, and the branch above tests `if
    // (inst.simplefin_org_id)`. An empty-string org id — a shape we never write
    // but could read back from a hand-edited row — is falsy, so it would fall
    // past the SimpleFIN branch and have its data deleted by a route the user
    // pressed expecting a reversible disconnect. Unknown shapes stop here.
    const isManualInstitution = inst.simplefin_org_id === null || inst.simplefin_org_id === undefined;
    if (!isManualInstitution) {
      return res.status(400).json({ error: 'Unrecognised institution feed; refusing to delete' });
    }

    // Cascades: accounts, and their transactions. Unlike the SimpleFIN branch
    // there is no tombstone to keep — nothing recreates a manual institution, so
    // deleting the row is the whole operation.
    const { error: delErr } = await supabase
      .from('institutions')
      .delete()
      .eq('id', inst.id);
    if (delErr) throw delErr;

    return res.status(200).json({ ok: true, deleted: true });
  } catch (err) {
    console.error('unlink-institution error', err?.response?.data || err);
    return res
      .status(500)
      .json({ error: err?.response?.data || err.message || 'Unknown error' });
  }
}
