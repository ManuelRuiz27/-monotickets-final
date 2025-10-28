import { createHmac, timingSafeEqual } from 'node:crypto';

import { getJwtClaims, getJwtExpirations } from '../config/jwt.js';

const JWT_ALGORITHM = 'HS256';
const DEFAULT_KEY_GRACE_PERIOD_SECONDS = 300;

export function getJwtSecret(env = process.env) {
  const keySet = getJwtKeySet(env);
  return keySet.active.secret;
}

export function getJwtKeySet(env = process.env) {
  const keys = resolveJwtKeys(env);
  if (keys.length === 0) {
    throw new Error('JWT secrets are not configured');
  }
  const graceSeconds = Math.max(
    0,
    Number.isFinite(Number(env.JWT_KEY_GRACE_PERIOD_SECONDS))
      ? Number(env.JWT_KEY_GRACE_PERIOD_SECONDS)
      : DEFAULT_KEY_GRACE_PERIOD_SECONDS,
  );
  const nowMs = Date.now();
  let active = keys
    .filter((key) => !key.expiresAtMs || key.expiresAtMs > nowMs)
    .sort((a, b) => (a.expiresAtMs ?? Number.POSITIVE_INFINITY) - (b.expiresAtMs ?? Number.POSITIVE_INFINITY))[0];

  if (!active) {
    active = keys[keys.length - 1];
  }

  if (!active) {
    throw new Error('Unable to determine active JWT secret');
  }

  return {
    active,
    keys,
    gracePeriodMs: graceSeconds * 1000,
  };
}

export function signAccessToken(payload, options = {}) {
  return signToken(payload, 'access', options);
}

export function signStaffToken(payload, options = {}) {
  return signToken(payload, 'staff', options);
}

export function signViewerToken(payload, options = {}) {
  return signToken(payload, 'viewer', options);
}

function signToken(payload, type, options = {}) {
  const { env = process.env } = options;
  const keySet = getJwtKeySet(env);
  const expirations = getJwtExpirations(env);
  const claims = getJwtClaims(env);
  const expiresInSeconds = expirations[type];

  if (!expiresInSeconds) {
    throw new Error(`Unknown JWT token type: ${type}`);
  }

  const header = {
    alg: JWT_ALGORITHM,
    typ: 'JWT',
    kid: keySet.active.id,
  };

  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenPayload = {
    ...payload,
    iss: claims.issuer,
    aud: claims.audience,
    tokenType: type,
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
  };

  const encodedHeader = encodeSegment(header);
  const encodedPayload = encodeSegment(tokenPayload);
  const signature = createSignature(`${encodedHeader}.${encodedPayload}`, keySet.active.secret);

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function decodeJwt(token) {
  const [encodedHeader, encodedPayload, signature] = token.split('.');

  if (!encodedHeader || !encodedPayload || !signature) {
    throw new Error('Invalid token format');
  }

  const header = decodeSegment(encodedHeader);
  const payload = decodeSegment(encodedPayload);

  return { header, payload, signature };
}

export function verifyJwt(token, keySet, options = {}) {
  const [encodedHeader, encodedPayload, signature] = token.split('.');

  if (!encodedHeader || !encodedPayload || !signature) {
    throw new Error('Invalid token format');
  }

  const header = decodeSegment(encodedHeader);
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const graceMs = Number.isFinite(options.gracePeriodMs) ? Number(options.gracePeriodMs) : keySet?.gracePeriodMs ?? 0;
  const keys = selectVerificationKeys({ header, keySet });

  for (const key of keys) {
    if (key.expiresAtMs && nowMs > key.expiresAtMs + graceMs) {
      continue;
    }
    const expectedSignature = createSignature(`${encodedHeader}.${encodedPayload}`, key.secret);
    if (expectedSignature.length !== signature.length) {
      continue;
    }
    if (timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return { valid: true, key, header };
    }
  }

  return { valid: false, reason: keys.length === 0 ? 'unknown_kid' : 'invalid_signature' };
}

function selectVerificationKeys({ header = {}, keySet }) {
  if (!keySet || !Array.isArray(keySet.keys)) {
    return [];
  }
  if (header?.kid) {
    const match = keySet.keys.find((key) => key.id === header.kid);
    return match ? [match] : [];
  }
  return keySet.keys;
}

function resolveJwtKeys(env = process.env) {
  const keys = [];
  if (env.JWT_KEYS) {
    let parsed;
    try {
      parsed = JSON.parse(env.JWT_KEYS);
    } catch (error) {
      throw new Error('JWT_KEYS must be valid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('JWT_KEYS must be an array');
    }
    parsed.forEach((entry, index) => {
      const normalized = normalizeKey(entry, `JWT_KEYS[${index}]`);
      keys.push(normalized);
    });
  }

  const fallbackSecret = typeof env.JWT_SECRET === 'string' ? env.JWT_SECRET.trim() : '';
  if (!fallbackSecret && keys.length === 0) {
    throw new Error('JWT_SECRET is not configured');
  }

  if (fallbackSecret) {
    const fallbackId = env.JWT_SECRET_ID || 'default';
    if (!keys.some((key) => key.id === fallbackId)) {
      keys.push({ id: fallbackId, secret: fallbackSecret, expiresAtMs: resolveExpires(env.JWT_SECRET_EXPIRES_AT) });
    }
  }

  const previousSecret = typeof env.JWT_SECRET_PREVIOUS === 'string' ? env.JWT_SECRET_PREVIOUS.trim() : '';
  if (previousSecret) {
    const previousId = env.JWT_SECRET_PREVIOUS_ID || 'previous';
    if (!keys.some((key) => key.id === previousId)) {
      keys.push({ id: previousId, secret: previousSecret, expiresAtMs: resolveExpires(env.JWT_SECRET_PREVIOUS_EXPIRES_AT) });
    }
  }

  return keys
    .filter((key) => key.secret)
    .map((key) => ({ ...key, secret: key.secret }))
    .sort((a, b) => (a.expiresAtMs ?? Number.POSITIVE_INFINITY) - (b.expiresAtMs ?? Number.POSITIVE_INFINITY));
}

function normalizeKey(entry, source = 'JWT_KEYS') {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${source} entries must be objects`);
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  const secret = typeof entry.secret === 'string' ? entry.secret.trim() : '';
  if (!id) {
    throw new Error(`${source} is missing id`);
  }
  if (!secret) {
    throw new Error(`${source} is missing secret`);
  }
  return {
    id,
    secret,
    expiresAtMs: resolveExpires(entry.expiresAt),
  };
}

function resolveExpires(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid expiresAt value for JWT key');
  }
  return date.getTime();
}

function createSignature(input, secret) {
  return createHmac('sha256', secret).update(input).digest('base64url');
}

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

export const internals = {
  signToken,
  createSignature,
  encodeSegment,
  decodeSegment,
  resolveJwtKeys,
  selectVerificationKeys,
};

