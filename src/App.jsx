import { useCallback, useEffect, useState } from 'react';
import { supabase, configError } from './supabaseClient.js';
import Dashboard from './components/Dashboard.jsx';
import AddAccount from './components/AddAccount.jsx';
import EmptyState from './components/EmptyState.jsx';
import Login from './components/Login.jsx';

function ConfigErrorScreen() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          background: 'var(--card)',
          border: '1px solid var(--danger-border)',
          borderRadius: 14,
          padding: 24,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>
          App configuration error
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)' }}>
          {configError}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [count, setCount] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session || !supabase) return;
    let cancelled = false;
    supabase
      .from('institutions')
      .select('id', { count: 'exact', head: true })
      .then(({ count: n, error }) => {
        if (cancelled) return;
        if (error) {
          // Don't fall back to the "add your first account" screen on a
          // transient query failure — keep whatever we knew before.
          console.error('institution count failed', error);
          setCount(prev => prev ?? 0);
        } else {
          setCount(n ?? 0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, refreshTick]);

  // Re-check when the app returns to the foreground (e.g. the iOS PWA was
  // frozen showing a stale screen while accounts were linked on another
  // device). Throttled so ordinary tab-switching doesn't flash reloads.
  useEffect(() => {
    let lastRefresh = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefresh < 60_000) return;
      lastRefresh = Date.now();
      setRefreshTick(t => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  const handleLinked = useCallback(() => {
    setRefreshTick(t => t + 1);
  }, []);

  if (configError) return <ConfigErrorScreen />;
  if (session === undefined) return null;
  if (!session) return <Login />;
  if (count === null) return null;

  if (count === 0) {
    return <EmptyState onLinked={handleLinked} />;
  }

  return (
    <>
      <Dashboard refreshTick={refreshTick} />
      <div
        style={{
          position: 'fixed',
          bottom: 'calc(16px + env(safe-area-inset-bottom))',
          right: 'calc(16px + env(safe-area-inset-right))',
          zIndex: 50,
        }}
      >
        <AddAccount onLinked={handleLinked} />
      </div>
    </>
  );
}
