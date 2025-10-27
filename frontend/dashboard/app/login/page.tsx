'use client';

import React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { CSSProperties } from 'react';
import { login } from '@/lib/api/auth';
import { useAuth } from '@/lib/auth/context';

const roles = [
  { value: 'organizer', label: 'Organizador' },
  { value: 'director', label: 'Director' },
  { value: 'staff', label: 'Staff' },
];

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const redirectTo = search?.get('redirectTo') || '/director';
  const { setSession, session } = useAuth();

  const [userId, setUserId] = React.useState('demo-user');
  const [role, setRole] = React.useState<typeof roles[number]['value']>('organizer');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (session) {
      router.replace(redirectTo);
    }
  }, [session, router, redirectTo]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await login({ userId, role });
      const stored = setSession({
        accessToken: response.accessToken,
        staffToken: response.staffToken,
        viewerToken: response.viewerToken,
      });
      if (!stored) {
        throw new Error('No se pudo guardar la sesión.');
      }
      router.replace(redirectTo);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error al iniciar sesión.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main style={containerStyle} aria-labelledby="login-title">
      <form onSubmit={handleSubmit} style={cardStyle} aria-describedby="login-description">
        <h1 id="login-title" style={titleStyle}>
          Acceso al dashboard
        </h1>
        <p id="login-description" style={bodyStyle}>
          Ingresa un identificador de usuario y selecciona tu rol para obtener un token JWT del backend real.
        </p>

        <label style={labelStyle}>
          <span>ID de usuario</span>
          <input
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            style={inputStyle}
            placeholder="org_demo"
            autoComplete="username"
            required
          />
        </label>

        <label style={labelStyle}>
          <span>Rol</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as typeof role)}
            style={{ ...inputStyle, appearance: 'none' }}
          >
            {roles.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p role="alert" style={errorStyle}>
            {error}
          </p>
        )}

        <button type="submit" style={submitStyle} disabled={submitting}>
          {submitting ? 'Generando tokens…' : 'Iniciar sesión'}
        </button>
      </form>
    </main>
  );
}

const containerStyle: CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'linear-gradient(135deg, rgba(59,130,246,0.12), rgba(79,70,229,0.18))',
  padding: 'clamp(16px, 4vw, 48px)',
};

const cardStyle: CSSProperties = {
  width: 'min(420px, 95vw)',
  background: '#fff',
  borderRadius: '24px',
  padding: 'clamp(24px, 4vw, 36px)',
  boxShadow: '0 30px 90px rgba(15, 23, 42, 0.18)',
  display: 'grid',
  gap: '18px',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-title)',
  fontSize: '1.75rem',
  color: 'var(--color-navy)',
};

const bodyStyle: CSSProperties = {
  margin: 0,
  color: 'rgba(15, 23, 42, 0.7)',
  lineHeight: 1.6,
};

const labelStyle: CSSProperties = {
  display: 'grid',
  gap: '6px',
  fontWeight: 600,
  color: 'rgba(15, 23, 42, 0.7)',
};

const inputStyle: CSSProperties = {
  borderRadius: '14px',
  border: '1px solid rgba(15, 23, 42, 0.12)',
  padding: '12px 16px',
  fontSize: '1rem',
  fontFamily: 'var(--font-body)',
};

const submitStyle: CSSProperties = {
  padding: '14px 20px',
  borderRadius: '999px',
  border: 'none',
  background: 'linear-gradient(135deg, var(--color-sky), #4338ca)',
  color: '#fff',
  fontWeight: 600,
  cursor: 'pointer',
};

const errorStyle: CSSProperties = {
  margin: 0,
  padding: '12px',
  borderRadius: '12px',
  background: 'rgba(239, 68, 68, 0.12)',
  color: '#b91c1c',
  fontSize: '0.9rem',
};
