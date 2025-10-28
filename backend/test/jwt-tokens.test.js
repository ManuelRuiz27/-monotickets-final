import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  decodeJwt,
  getJwtSecret,
  getJwtKeySet,
  signAccessToken,
  signStaffToken,
  signViewerToken,
  verifyJwt,
} from '../src/auth/tokens.js';

describe('JWT token helpers', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.JWT_ACCESS_EXP = '1h';
    process.env.JWT_STAFF_EXP = '2h';
    process.env.JWT_VIEWER_EXP = '30m';
    delete process.env.JWT_KEYS;
    delete process.env.JWT_SECRET_PREVIOUS;
    delete process.env.JWT_SECRET_PREVIOUS_ID;
    delete process.env.JWT_SECRET_PREVIOUS_EXPIRES_AT;
    delete process.env.JWT_SECRET_ID;
    delete process.env.JWT_SECRET_EXPIRES_AT;
    delete process.env.JWT_KEY_GRACE_PERIOD_SECONDS;
  });

  afterEach(() => {
    Object.assign(process.env, originalEnv);
    for (const key of [
      'JWT_SECRET',
      'JWT_ACCESS_EXP',
      'JWT_STAFF_EXP',
      'JWT_VIEWER_EXP',
      'JWT_KEYS',
      'JWT_SECRET_PREVIOUS',
      'JWT_SECRET_PREVIOUS_ID',
      'JWT_SECRET_PREVIOUS_EXPIRES_AT',
      'JWT_SECRET_ID',
      'JWT_SECRET_EXPIRES_AT',
      'JWT_KEY_GRACE_PERIOD_SECONDS',
    ]) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  it('requires JWT_SECRET to be configured', () => {
    delete process.env.JWT_SECRET;

    assert.throws(() => {
      getJwtSecret(process.env);
    }, /not configured/);
  });

  it('signs access tokens with configured expiration', () => {
    const token = signAccessToken({ sub: 'user-1' }, { env: process.env });
    const { payload } = decodeJwt(token);

    assert.equal(payload.sub, 'user-1');
    assert.equal(payload.exp - payload.iat, 60 * 60);
  });

  it('signs staff tokens with configured expiration', () => {
    const token = signStaffToken({ sub: 'user-1' }, { env: process.env });
    const { payload } = decodeJwt(token);

    assert.equal(payload.exp - payload.iat, 2 * 60 * 60);
  });

  it('signs viewer tokens with configured expiration', () => {
    const token = signViewerToken({ sub: 'user-1' }, { env: process.env });
    const { payload } = decodeJwt(token);

    assert.equal(payload.exp - payload.iat, 30 * 60);
  });

  it('includes the active key id in the token header', () => {
    process.env.JWT_KEYS = JSON.stringify([
      { id: 'current-key', secret: 'rotating-secret', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    ]);

    const token = signAccessToken({ sub: 'user-42' }, { env: process.env });
    const { header } = decodeJwt(token);

    assert.equal(header.kid, 'current-key');
  });

  it('verifies tokens with rotated keys within the grace period', () => {
    const baseTime = Date.now();
    process.env.JWT_KEYS = JSON.stringify([
      { id: 'old-key', secret: 'old-secret', expiresAt: new Date(baseTime + 1_000).toISOString() },
    ]);
    let token = signAccessToken({ sub: 'user-rotated' }, { env: process.env });

    process.env.JWT_KEYS = JSON.stringify([
      { id: 'old-key', secret: 'old-secret', expiresAt: new Date(baseTime + 1_000).toISOString() },
      { id: 'current-key', secret: 'current-secret', expiresAt: new Date(baseTime + 3_600_000).toISOString() },
    ]);
    process.env.JWT_KEY_GRACE_PERIOD_SECONDS = '120';
    const keySet = getJwtKeySet(process.env);
    const verification = verifyJwt(token, keySet, { nowMs: baseTime + 30_000 });

    assert.equal(verification.valid, true);
    assert.equal(verification.key.id, 'old-key');

    process.env.JWT_KEYS = JSON.stringify([
      { id: 'current-key', secret: 'current-secret', expiresAt: new Date(baseTime + 3_600_000).toISOString() },
    ]);
    token = signAccessToken({ sub: 'user-new' }, { env: process.env });
    const newKeySet = getJwtKeySet(process.env);
    const newVerification = verifyJwt(token, newKeySet, { nowMs: baseTime + 60_000 });
    assert.equal(newVerification.valid, true);
    assert.equal(newVerification.key.id, 'current-key');
  });
});
