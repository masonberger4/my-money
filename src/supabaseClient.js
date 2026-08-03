import { createClient } from '@supabase/supabase-js';

// `import.meta.env` is always defined under Vite; guard it so importing this
// module in a plain Node context (the CSV-import dry-run harness) doesn't throw
// before the ConfigErrorScreen can render.
const env = import.meta.env || {};
const url = env.VITE_SUPABASE_URL;
// Supabase renamed its client key "anon" → "Publishable" (sb_publishable_…).
// New name preferred; the legacy var name keeps working so an un-migrated
// Vercel env doesn't brick the build.
const anonKey =
  env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;

// Vite bakes VITE_* vars in at build time. If they're missing we don't throw
// here — that would blank the whole app before React mounts. App.jsx checks
// configError and renders a readable explanation instead.
export const configError =
  !url || !anonKey
    ? 'Missing VITE_SUPABASE_URL and/or VITE_SUPABASE_PUBLISHABLE_KEY ' +
      '(the sb_publishable_… key; legacy name VITE_SUPABASE_ANON_KEY also accepted). ' +
      'These must be set as environment variables when the app is BUILT ' +
      '(locally: .env.local; Vercel: Project Settings → Environment Variables, ' +
      'enabled for this deployment type, then redeploy).'
    : null;

export const supabase = configError ? null : createClient(url, anonKey);

export async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}
