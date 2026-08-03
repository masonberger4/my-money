import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { supabase, configError } from './supabaseClient.js';
import Dashboard from './components/Dashboard.jsx';
// Lazy: EmptyState statically imports the CsvImport modal, which Dashboard
// loads lazily — a static import here would pull the whole import stack back
// into the main bundle and defeat that split.
const EmptyState = lazy(() => import('./components/EmptyState.jsx'));
import Login from './components/Login.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

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

// Cold-start skeleton — shown while auth / the institution count resolve, so a
// cold start is never a blank page. Token-styled only (ui.css is global, so the
// tokens and the `pulse` keyframe are available pre-Dashboard); deliberately
// local to App.jsx — importing Dashboard's Sk across the lazy boundary would
// drag chunks into the main bundle.
function SkBlock({ w = '100%', h = 16 }) {
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: 6,
        background: 'var(--border)',
        animation: 'pulse 1.5s ease-in-out infinite',
      }}
    />
  );
}

function StartupSkeleton() {
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
          width: 'min(360px, 92vw)',
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        <SkBlock w="55%" h={12} />
        <SkBlock w="80%" h={22} />
        <SkBlock h={12} />
        <SkBlock w="70%" h={12} />
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
  if (session === undefined) return <StartupSkeleton />;
  if (!session) return <Login />;
  if (count === null) return <StartupSkeleton />;

  if (count === 0) {
    return (
      <ErrorBoundary label="empty state render failed">
        <Suspense fallback={<StartupSkeleton />}>
          <EmptyState onLinked={handleLinked} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary label="dashboard render failed">
      <Dashboard refreshTick={refreshTick} />
    </ErrorBoundary>
  );
}
