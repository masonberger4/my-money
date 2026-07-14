import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example)'
  );
}

export const supabase = createClient(url, anonKey);

export async function getAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}
