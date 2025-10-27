'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { CSSProperties } from 'react';
import { useAuth } from '@/lib/auth/context';

const navLinks = [
  { href: '/director', label: 'Director' },
  { href: '/organizer', label: 'Organizador' },
  { href: '/receivables', label: 'Cuentas por cobrar' },
  { href: '/payments', label: 'Pagos' },
  { href: '/pricing', label: 'Precios' },
];

export function DashboardHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const { session, logout, initializing } = useAuth();

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <header style={headerStyle}>
      <div>
        <p style={eyebrowStyle}>Panel Monotickets</p>
        <h1 style={titleStyle}>Operación de eventos</h1>
      </div>
      <nav aria-label="Secciones principales" style={navStyle}>
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            style={{
              ...navLinkStyle,
              ...(pathname?.startsWith(link.href) ? activeNavStyle : {}),
            }}
          >
            {link.label}
          </Link>
        ))}
      </nav>
      <div style={sessionContainerStyle}>
        {initializing ? (
          <span style={sessionTextStyle}>Verificando sesión…</span>
        ) : session ? (
          <>
            <span style={sessionTextStyle}>
              {session.userId ? `ID ${session.userId}` : 'Sesión activa'} · Rol {session.role}
            </span>
            <button type="button" onClick={handleLogout} style={logoutButtonStyle}>
              Cerrar sesión
            </button>
          </>
        ) : (
          <Link href="/login" style={loginLinkStyle}>
            Iniciar sesión
          </Link>
        )}
      </div>
    </header>
  );
}

const headerStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: '16px',
  padding: 'clamp(16px, 4vw, 32px)',
  width: 'min(1100px, 95vw)',
  margin: '0 auto',
};

const eyebrowStyle: CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  fontSize: '0.8rem',
  margin: 0,
  color: 'rgba(15, 23, 42, 0.6)',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 'clamp(1.8rem, 3vw, 2.4rem)',
  fontFamily: 'var(--font-title)',
};

const navStyle: CSSProperties = {
  display: 'flex',
  gap: '12px',
  flexWrap: 'wrap',
};

const navLinkStyle: CSSProperties = {
  textDecoration: 'none',
  padding: '10px 18px',
  borderRadius: '999px',
  background: 'rgba(37, 99, 235, 0.12)',
  color: 'var(--color-sky)',
  fontWeight: 600,
  transition: 'transform 0.2s ease',
};

const activeNavStyle: CSSProperties = {
  background: 'linear-gradient(135deg, var(--color-sky), #4338ca)',
  color: '#fff',
  transform: 'translateY(-2px)',
};

const sessionContainerStyle: CSSProperties = {
  display: 'flex',
  gap: '12px',
  alignItems: 'center',
  flexWrap: 'wrap',
};

const sessionTextStyle: CSSProperties = {
  margin: 0,
  fontSize: '0.85rem',
  color: 'rgba(15, 23, 42, 0.65)',
};

const logoutButtonStyle: CSSProperties = {
  padding: '8px 16px',
  borderRadius: '999px',
  border: '1px solid rgba(15, 23, 42, 0.12)',
  background: '#fff',
  color: 'rgba(15, 23, 42, 0.8)',
  fontWeight: 600,
  cursor: 'pointer',
};

const loginLinkStyle: CSSProperties = {
  ...logoutButtonStyle,
  textDecoration: 'none',
};
