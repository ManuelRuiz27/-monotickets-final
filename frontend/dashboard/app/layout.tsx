import type { Metadata } from 'next';
import './globals.css';
import { AppProviders } from './providers';
import { DashboardHeader } from './_components/DashboardHeader';

export const metadata: Metadata = {
  title: 'Monotickets · Panel organizadores',
  description: 'Dashboard conectado al backend de Monotickets para directores y organizadores.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <AppProviders>
          <DashboardHeader />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
