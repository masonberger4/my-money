import { createClient } from '@supabase/supabase-js';

// Service-role client: bypasses RLS. Server-side only — this is how the API
// routes read plaid_tokens, which no client-facing policy exposes.
let serviceClient = null;

export function getServiceClient() {
  if (serviceClient) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}

// Verify the caller's Supabase JWT and resolve their household.
// Returns { userId, householdId } or sends a 401 and returns null.
export async function requireUser(req, res) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Missing Authorization bearer token' });
    return null;
  }

  const supabase = getServiceClient();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return null;
  }

  const { data: member, error: memberErr } = await supabase
    .from('household_members')
    .select('household_id')
    .eq('user_id', userData.user.id)
    .limit(1)
    .maybeSingle();
  if (memberErr || !member) {
    res.status(403).json({ error: 'User is not in a household' });
    return null;
  }

  return { userId: userData.user.id, householdId: member.household_id };
}
