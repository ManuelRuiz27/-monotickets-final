import { handleError } from '@shared/api/errors';

const API_BASE =
  process.env.DASHBOARD_NEXT_PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '';

export interface LoginRequest {
  userId: string;
  role: 'organizer' | 'director' | 'staff' | 'viewer' | 'admin';
}

export interface LoginResponse {
  accessToken: string;
  staffToken?: string;
  viewerToken?: string;
  requestId?: string;
}

export async function login({ userId, role }: LoginRequest): Promise<LoginResponse> {
  if (!API_BASE) {
    throw new Error('API base URL no configurada. Define NEXT_PUBLIC_API_URL.');
  }

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, role }),
    cache: 'no-store',
  });

  if (!res.ok) {
    await handleError(res, { scope: 'auth-login', request: '/auth/login' });
  }

  return (await res.json()) as LoginResponse;
}
