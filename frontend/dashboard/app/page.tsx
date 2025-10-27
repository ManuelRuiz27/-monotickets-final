'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';

export default function DashboardLandingPage() {
  return (
    <main style={containerStyle}>
      <article style={cardStyle}>
        <h2 style={titleStyle}>Elige una vista</h2>
        <p style={bodyStyle}>
          Inicia sesión para navegar el panel conectado al backend real de Monotickets. Las métricas y acciones utilizan la API
          compartida con producción.
        </p>
        <div style={ctaGroupStyle} role="navigation" aria-label="Vistas disponibles">
          <Link href="/director" style={primaryCtaStyle}>
            Panel del director
          </Link>
          <Link href="/organizer" style={secondaryCtaStyle}>
            Panel del organizador
          </Link>
          <Link href="/login" style={secondaryCtaStyle}>
            Iniciar sesión
          </Link>
        </div>
      </article>
    </main>
  );
}

const containerStyle: CSSProperties = {
  width: 'min(960px, 95vw)',
  margin: '0 auto',
  padding: 'clamp(24px, 4vw, 48px) 0',
};

const cardStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.95)',
  borderRadius: '20px',
  padding: 'clamp(24px, 5vw, 36px)',
  boxShadow: '0 16px 40px rgba(15, 23, 42, 0.14)',
  display: 'grid',
  gap: '16px',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-title)',
  fontSize: 'clamp(1.8rem, 3vw, 2.4rem)',
};

const bodyStyle: CSSProperties = {
  margin: 0,
  color: 'rgba(15, 23, 42, 0.7)',
  lineHeight: 1.6,
};

const ctaGroupStyle: CSSProperties = {
  display: 'flex',
  gap: '12px',
  flexWrap: 'wrap',
};

const primaryCtaStyle: CSSProperties = {
  textDecoration: 'none',
  padding: '12px 24px',
  borderRadius: '999px',
  background: 'linear-gradient(135deg, var(--color-sky), #4338ca)',
  color: '#fff',
  fontWeight: 600,
};

const secondaryCtaStyle: CSSProperties = {
  textDecoration: 'none',
  padding: '12px 24px',
  borderRadius: '999px',
  border: '1px solid rgba(15, 23, 42, 0.12)',
  color: 'var(--color-sky)',
  background: '#fff',
  fontWeight: 600,
};
