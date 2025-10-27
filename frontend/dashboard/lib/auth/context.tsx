'use client';

import React from 'react';
import type { LoginTokens, StoredSession } from './session';
import { clearSession, getSession, storeSession } from './session';

interface AuthContextValue {
  session: StoredSession | null;
  initializing: boolean;
  setSession: (tokens: LoginTokens) => StoredSession | null;
  logout: () => void;
  refresh: () => void;
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSessionState] = React.useState<StoredSession | null>(null);
  const [initializing, setInitializing] = React.useState(true);

  React.useEffect(() => {
    setSessionState(getSession());
    setInitializing(false);
  }, []);

  const setSession = React.useCallback((tokens: LoginTokens) => {
    const stored = storeSession(tokens);
    setSessionState(stored);
    return stored;
  }, []);

  const logout = React.useCallback(() => {
    clearSession();
    setSessionState(null);
  }, []);

  const refresh = React.useCallback(() => {
    setSessionState(getSession());
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ session, initializing, setSession, logout, refresh }),
    [session, initializing, setSession, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
