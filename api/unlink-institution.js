import { getServiceClient, requireUser } from './_lib/supabase.js';

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
    // find this org again and recreate it. Instead: drop its accounts (which
    // cascades their transactions) and keep the institution as a disabled
    // tombstone — api/sync.js skips disabled institutions, so the org stays out
    // of the app until the user reconnects it. To stop the bank feeding
    // SimpleFIN at all, they remove it at SimpleFIN Bridge.
    if (inst.simplefin_org_id) {
      const { error: acctErr } = await supabase
        .from('accounts')
        .delete()
        .eq('institution_id', inst.id);
      if (acctErr) throw acctErr;

      const { error: disableErr } = await supabase
        .from('institutions')
        .update({ status: 'disabled', last_error: null, sync_state: {} })
        .eq('id', inst.id);
      if (disableErr) throw disableErr;

      return res.status(200).json({ ok: true, disabled: true });
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
