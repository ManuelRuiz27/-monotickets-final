'use client';

import React from 'react';
import { AuthProvider } from '@/lib/auth/context';

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
