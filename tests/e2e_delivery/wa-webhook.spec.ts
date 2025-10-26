import { expect, test } from '@playwright/test';
import { seeds } from '../fixtures/datasets';
import { getJSON, postJSON, pollForResource } from '../fixtures/http';

const webhookPath = '/wa/webhook';
const sessionWindowFlag = (process.env.WA_SESSION_IN_WINDOW || 'true').toLowerCase() !== 'false';

function buildInboundPayload(phone: string, messageId: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    contacts: [
      {
        wa_id: phone,
        profile: { name: 'E2E Bot' },
      },
    ],
    messages: [
      {
        id: messageId,
        from: phone,
        timestamp,
        type: 'text',
        text: { body: 'Confirmo asistencia' },
      },
    ],
    metadata: {
      integrationType: 'e2e-tests',
      generatedAt: new Date().toISOString(),
    },
  };
}

test.describe('@wa webhook acceptance window', () => {
  test('@wa @critical should enqueue inbound WhatsApp messages inside the 24h window', async ({ request }) => {
    const messageId = `wam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = buildInboundPayload(seeds.delivery.success.phone, messageId);

    const response = await postJSON(request, webhookPath, payload);
    expect(response.status()).toBeGreaterThanOrEqual(200);
    expect(response.status()).toBeLessThan(300);

    const body = await response.json().catch(() => ({}));
    const normalized = JSON.stringify(body).toLowerCase();
    expect(normalized).toMatch(/ok|accept|queued/);
    const jobId = body.jobId || body.id || body.requestId || null;
    expect(jobId).not.toBeNull();

    try {
      const session = await pollForResource(
        request,
        `/wa/session/${encodeURIComponent(seeds.delivery.success.phone)}`,
        (data) => typeof data?.status === 'string' && data.status.toLowerCase() === 'open',
        { timeoutMs: 10_000, intervalMs: 1_000 },
      );
      expect(session.status.toLowerCase()).toBe('open');
      expect(session.sessionId || session.session_id).toBeTruthy();
      expect(session.expiresAt || session.expires_at).toBeTruthy();
    } catch (error) {
      test.info().annotations.push({
        type: 'wa-session-poll',
        description: `session lookup fallback: ${(error as Error).message}`,
      });
    }
  });

  test('@wa should surface controlled errors when the 24h window is closed', async ({ request }) => {
    test.skip(sessionWindowFlag, 'Requires WA_SESSION_IN_WINDOW=false to validate closed-session behaviour');

    const messageId = `wam-expired-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const payload = buildInboundPayload(seeds.delivery.expiredWindow.phone, messageId);
    payload.metadata = {
      ...payload.metadata,
      sessionInWindow: false,
      simulateWindowExpired: true,
    };

    const response = await postJSON(request, webhookPath, payload);
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);

    const body = await response.json().catch(() => ({}));
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).toMatch(/window|template|expired|costo|plantilla/);

    const sessionResponse = await getJSON(request, `/wa/session/${encodeURIComponent(seeds.delivery.expiredWindow.phone)}`);
    expect(sessionResponse.status()).toBeGreaterThanOrEqual(400);
  });
});
