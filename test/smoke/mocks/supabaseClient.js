// Fifth harness mock: the direct supabaseClient import App.jsx legitimately
// makes (App sits ABOVE the dataAdapter façade — the four-module import rule
// is Dashboard's, not App's). Mocking it lets the render gate mount the REAL
// App: auth resolution, the institution-count gate, ErrorBoundary, and the
// count>0 → Dashboard branch — the startup path that used to be the one
// recorded harness gap.
//
// HEALTHY PATH ONLY, deliberately: a session is present and the count query
// succeeds with a positive count, so App lands on <Dashboard/>. The
// error-path behaviors (EmptyState-on-cold-failure and friends) are
// user-facing decisions the killed backlog item tried to assert and got
// killed for — this mock must not quietly re-litigate them.

const session = {
  user: { id: 'aaaaaaaa-0000-0000-0000-0000000000aa', email: 'smoke@example.test' },
  access_token: 'smoke-token',
};

export const configError = null;

export const supabase = {
  auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
  // App's only query: the institutions head-count. Thenable rather than a
  // Promise-returning chain end because the real PostgREST builder is awaited
  // directly off .select().
  from: () => ({
    select: () => Promise.resolve({ count: 3, error: null }),
  }),
};

export async function getAccessToken() {
  return session.access_token;
}
