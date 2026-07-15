import { useCallback, useEffect, useState } from 'react';
import { supabase, configError } from './supabaseClient.js';
import Dashboard from './components/Dashboard.jsx';
import LinkAccount from './components/LinkAccount.jsx';
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
        background: '#F7F6F2',
        color: '#1a1a18',
        fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          background: '#FFFFFF',
          border: '1px solid #F09595',
          borderRadius: 14,
          padding: 24,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>
          App configuration error
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: '#5a5a56' }}>
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
        if (!cancelled) setCount(error ? 0 : n ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, [session, refreshTick]);

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
          bottom: 16,
          right: 16,
          zIndex: 50,
        }}
      >
        <LinkAccount onLinked={handleLinked} />
      </div>
    </>
  );
}
