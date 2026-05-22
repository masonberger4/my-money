import { useCallback, useEffect, useState } from 'react';
import { db } from './db.js';
import Dashboard from './components/Dashboard.jsx';
import LinkAccount from './components/LinkAccount.jsx';
import EmptyState from './components/EmptyState.jsx';

export default function App() {
  const [count, setCount] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    db.institutions.count().then(n => {
      if (!cancelled) setCount(n);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const handleLinked = useCallback(() => {
    setRefreshTick(t => t + 1);
  }, []);

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
