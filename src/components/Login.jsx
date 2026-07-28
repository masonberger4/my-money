import { useState } from 'react';
import { supabase } from '../supabaseClient.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (err) {
      setError(err.message || 'Sign-in failed');
      setLoading(false);
    }
    // On success onAuthStateChange in App.jsx re-renders past this screen.
  }

  const inputStyle = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    marginBottom: 12,
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: "'DM Sans','Helvetica Neue',sans-serif",
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          padding: '28px 28px 24px',
          maxWidth: 360,
          width: '100%',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '.08em',
            color: 'var(--muted)',
            textTransform: 'uppercase',
            marginBottom: 8,
            textAlign: 'center',
          }}
        >
          my-money
        </div>
        <div
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: '-.02em',
            marginBottom: 20,
            textAlign: 'center',
          }}
        >
          Sign in
        </div>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="username"
          style={inputStyle}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          style={inputStyle}
        />
        {error && (
          <div
            style={{
              background: 'var(--danger-bg)',
              border: '1px solid var(--danger-border)',
              borderRadius: 8,
              padding: '8px 12px',
              fontSize: 12,
              color: 'var(--danger)',
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}
        <button
          type="submit"
          disabled={loading || !email.trim() || !password}
          style={{
            width: '100%',
            padding: '10px 0',
            borderRadius: 8,
            border: 'none',
            background: 'var(--accent)',
            color: 'var(--accent-text)',
            fontFamily: 'inherit',
            fontSize: 14,
            fontWeight: 500,
            cursor: loading ? 'default' : 'pointer',
            opacity: loading || !email.trim() || !password ? 0.6 : 1,
          }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
