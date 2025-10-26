import { expect, test } from '@playwright/test';
import { deliveryRoutes, seeds } from '../fixtures/datasets';
import { getJSON, postJSON, waitForWebhookReceipt } from '../fixtures/http';

const defaultSessionFlag = (process.env.WA_SESSION_IN_WINDOW || 'true').toLowerCase() !== 'false';

function buildMetadata(inWindow: boolean) {
  return {
    ticketCode: seeds.delivery.success.metadata.ticketCode,
    channel: 'whatsapp',
    sessionInWindow: inWindow,
    simulateWindowExpired: !inWindow,
    requireTemplate: !inWindow,
    simulateInbound: true,
  };
}

test.describe('@wa @delivery @window WhatsApp session handling', () => {
  test('@wa @delivery @window should accept replies within the 24h window', async ({ request }) => {
    const response = await postJSON(request, deliveryRoutes.send, {
      eventId: seeds.delivery.eventId,
      to: seeds.delivery.success.phone,
      template: seeds.delivery.success.template,
      locale: seeds.delivery.success.locale,
      metadata: {
        ...seeds.delivery.success.metadata,
        ...buildMetadata(true),
        windowAssertedBy: 'in-window',
      },
    });

    expect(response.status()).toBeGreaterThanOrEqual(200);
    expect(response.status()).toBeLessThan(300);

    const body = await response.json();
    const messageId = body.messageId || body.id || body.deliveryId;
    expect(messageId).toBeTruthy();
    expect((body.status || body.state || '').toLowerCase()).toMatch(/accept|ok|queued/);

    const webhookPayload = await waitForWebhookReceipt(request, messageId, {
      timeoutMs: 20_000,
      intervalMs: 1_000,
    });

    const matchedEvent = Array.isArray(webhookPayload?.events)
      ? webhookPayload.events.find((event: any) => event.messageId === messageId)
      : undefined;
    expect(matchedEvent).toBeTruthy();

    const logResponse = await getJSON(request, deliveryRoutes.logs, {
      query: { messageId },
    });
    expect(logResponse.ok()).toBeTruthy();
    const logs = await logResponse.json();
    const logEntry = Array.isArray(logs?.entries)
      ? logs.entries.find((entry: any) => entry.messageId === messageId)
      : logs;
    expect(logEntry).toBeTruthy();
    expect((logEntry.status || logEntry.state || '').toLowerCase()).toMatch(/accept|sent|delivered/);
    const isFreeFlag =
      typeof logEntry.isFree === 'boolean'
        ? logEntry.isFree
        : typeof logEntry.is_free === 'boolean'
          ? logEntry.is_free
          : undefined;
    expect(isFreeFlag).toBe(true);
    const sessionFromLog = logEntry.sessionId || logEntry.session_id;
    expect(sessionFromLog).toBeTruthy();
  });

  test('@wa @delivery @window should require template when the session is expired', async ({ request }) => {
    const response = await postJSON(request, deliveryRoutes.send, {
      eventId: seeds.delivery.eventId,
      to: seeds.delivery.expiredWindow.phone,
      template: seeds.delivery.expiredWindow.template,
      locale: seeds.delivery.expiredWindow.locale,
      metadata: {
        ...seeds.delivery.expiredWindow.metadata,
        ...buildMetadata(false),
        windowAssertedBy: 'expired',
      },
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);

    const body = await response.json().catch(() => ({}));
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).toContain('window');
    expect(serialized).toMatch(/template|plantilla|costo/);
    test.info().annotations.push({
      type: 'wa-session-toggle',
      description: `WA_SESSION_IN_WINDOW=${String(defaultSessionFlag)}`,
    });
  });
});
