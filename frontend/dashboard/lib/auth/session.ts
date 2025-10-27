'use client';

export interface StoredSession {
  accessToken: string;
  staffToken?: string;
  viewerToken?: string;
  role: string;
  userId?: string;
  expiresAt?: number;
}

const ACCESS_COOKIE = 'mt_access_token';
const STAFF_COOKIE = 'mt_staff_token';
const VIEWER_COOKIE = 'mt_viewer_token';
const ROLE_COOKIE = 'mt_role';
const USER_COOKIE = 'mt_user';

function decodeJwt(token: string) {
  try {
    const [, payload] = token.split('.');
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(globalThis.atob?.(normalized) ?? atobPolyfill(normalized));
    return decoded as { exp?: number; sub?: string; role?: string };
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[auth] Failed to decode JWT', error);
    }
    return null;
  }
}

function atobPolyfill(value: string) {
  if (typeof Buffer === 'function') {
    return Buffer.from(value, 'base64').toString('utf8');
  }
  throw new Error('No base64 decoder available');
}

function setCookie(name: string, value: string, maxAgeSeconds: number) {
  const attributes = [`max-age=${Math.max(0, Math.floor(maxAgeSeconds))}`, 'path=/', 'samesite=lax'];
  if (typeof window !== 'undefined' && window.location.protocol === 'https:') {
    attributes.push('secure');
  }
  document.cookie = `${name}=${encodeURIComponent(value)}; ${attributes.join('; ')}`;
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; max-age=0; path=/; samesite=lax`;
}

function getCookieMap() {
  if (typeof document === 'undefined') return new Map<string, string>();
  const map = new Map<string, string>();
  const entries = document.cookie.split(';');
  for (const entry of entries) {
    const [rawKey, ...rawValue] = entry.trim().split('=');
    if (!rawKey) continue;
    map.set(rawKey, decodeURIComponent(rawValue.join('=') ?? ''));
  }
  return map;
}

export interface LoginTokens {
  accessToken: string;
  staffToken?: string;
  viewerToken?: string;
}

export function storeSession(tokens: LoginTokens) {
  const decoded = decodeJwt(tokens.accessToken);
  const now = Math.floor(Date.now() / 1000);
  const accessExpiry = decoded?.exp ? Math.max(0, decoded.exp - now) : getDefaultAccessTtl();
  setCookie(ACCESS_COOKIE, tokens.accessToken, accessExpiry);

  if (tokens.staffToken) {
    const staffDecoded = decodeJwt(tokens.staffToken);
    const staffExpiry = staffDecoded?.exp ? Math.max(0, staffDecoded.exp - now) : getDefaultStaffTtl();
    setCookie(STAFF_COOKIE, tokens.staffToken, staffExpiry);
  }

  if (tokens.viewerToken) {
    const viewerDecoded = decodeJwt(tokens.viewerToken);
    const viewerExpiry = viewerDecoded?.exp ? Math.max(0, viewerDecoded.exp - now) : getDefaultAccessTtl();
    setCookie(VIEWER_COOKIE, tokens.viewerToken, viewerExpiry);
  }

  if (decoded?.role) {
    setCookie(ROLE_COOKIE, decoded.role, accessExpiry);
  }
  if (decoded?.sub) {
    setCookie(USER_COOKIE, decoded.sub, accessExpiry);
  }

  return getSession();
}

export function clearSession() {
  deleteCookie(ACCESS_COOKIE);
  deleteCookie(STAFF_COOKIE);
  deleteCookie(VIEWER_COOKIE);
  deleteCookie(ROLE_COOKIE);
  deleteCookie(USER_COOKIE);
}

export function getSession(): StoredSession | null {
  const cookies = getCookieMap();
  const accessToken = cookies.get(ACCESS_COOKIE);
  if (!accessToken) return null;
  const decoded = decodeJwt(accessToken);
  return {
    accessToken,
    staffToken: cookies.get(STAFF_COOKIE) || undefined,
    viewerToken: cookies.get(VIEWER_COOKIE) || undefined,
    role: cookies.get(ROLE_COOKIE) || decoded?.role || 'viewer',
    userId: cookies.get(USER_COOKIE) || decoded?.sub,
    expiresAt: decoded?.exp ? decoded.exp * 1000 : undefined,
  };
}

function getDefaultAccessTtl() {
  const fallback = Number(process.env.NEXT_PUBLIC_JWT_TTL_HOURS || 8) * 3600;
  return Number.isFinite(fallback) ? fallback : 8 * 3600;
}

function getDefaultStaffTtl() {
  const fallback = Number(process.env.NEXT_PUBLIC_STAFF_TOKEN_TTL_HOURS || 24) * 3600;
  return Number.isFinite(fallback) ? fallback : 24 * 3600;
}
