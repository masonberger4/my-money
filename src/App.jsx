import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient.js';
import Dashboard from './components/Dashboard.jsx';
import LinkAccount from './components/LinkAccount.jsx';
import EmptyState from './components/EmptyState.jsx';
import Login from './components/Login.jsx';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading
  const [count, setCount] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
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
