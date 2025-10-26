import { expect, test } from '@playwright/test';
import { deliveryRoutes, seeds } from '../fixtures/datasets';
import { postJSON, waitForWebhookReceipt, pollForResource, getJSON } from '../fixtures/http';

test.describe('@delivery whatsapp delivery flows', () => {
  test('@wa should accept a delivery and confirm webhook reception', async ({ request }) => {
    const response = await postJSON(request, deliveryRoutes.send, {
      eventId: seeds.delivery.eventId,
      to: seeds.delivery.success.phone,
      template: seeds.delivery.success.template,
      locale: seeds.delivery.success.locale,
      metadata: seeds.delivery.success.metadata,
    });

    expect(response.status(), 'delivery send response status').toBeGreaterThanOrEqual(200);
    expect(response.status(), 'delivery send response status').toBeLessThan(300);

    const body = await response.json();
    const messageId = body.messageId || body.id || body.deliveryId;
    expect(messageId, 'delivery message id').toBeTruthy();
    expect((body.status || body.state || '').toLowerCase()).toContain('accept');

    const webhookPayload = await waitForWebhookReceipt(request, messageId, {
      timeoutMs: 20_000,
      intervalMs: 1_000,
    });

    const receivedEvent = webhookPayload.events.find((event: any) => event.messageId === messageId);
    expect(receivedEvent, 'webhook event for delivery').toBeTruthy();
    expect(receivedEvent.status || receivedEvent.state).toMatch(/2\d\d/);

    const logResponse = await getJSON(request, `${deliveryRoutes.logs}?messageId=${encodeURIComponent(messageId)}`);
    expect(logResponse.ok()).toBeTruthy();
    const logs = await logResponse.json();
    const logEntry = Array.isArray(logs?.entries)
      ? logs.entries.find((entry: any) => entry.messageId === messageId)
      : logs;
    expect(logEntry).toBeTruthy();
    expect((logEntry.status || logEntry.state || '').toLowerCase()).toMatch(/accepted|sent/);
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

  test('@wa should reject deliveries outside the 24h window', async ({ request }) => {
    const response = await postJSON(request, deliveryRoutes.send, {
      eventId: seeds.delivery.eventId,
      to: seeds.delivery.expiredWindow.phone,
      template: seeds.delivery.expiredWindow.template,
      locale: seeds.delivery.expiredWindow.locale,
      metadata: {
        ...seeds.delivery.expiredWindow.metadata,
        simulateWindowExpired: true,
      },
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);

    const body = await response.json().catch(() => ({}));
    expect(JSON.stringify(body).toLowerCase()).toContain('window');
    expect(JSON.stringify(body).toLowerCase()).toContain('expired');
  });

  test('@wa should retry transient failures once and end in DLQ when exhausted', async ({ request }) => {
    const response = await postJSON(request, deliveryRoutes.send, {
      eventId: seeds.delivery.eventId,
      to: seeds.delivery.transientFailure.phone,
      template: seeds.delivery.transientFailure.template,
      locale: seeds.delivery.transientFailure.locale,
      metadata: {
        ...seeds.delivery.transientFailure.metadata,
        simulateTransientFailure: true,
        maxAttempts: 2,
      },
    });

    expect(response.status(), 'transient delivery enqueue').toBeGreaterThanOrEqual(200);
    expect(response.status(), 'transient delivery enqueue').toBeLessThan(300);

    const body = await response.json();
    const messageId = body.messageId || body.id || body.deliveryId;
    expect(messageId).toBeTruthy();

    const statusResource = `${deliveryRoutes.status}/${encodeURIComponent(messageId)}`;
    const statusPayload = await pollForResource(
      request,
      statusResource,
      (payload) => {
        const normalized = (payload.status || payload.state || '').toLowerCase();
        return normalized === 'sent' || normalized === 'delivered' || normalized === 'dead_letter';
      },
      { timeoutMs: 30_000, intervalMs: 1_000 },
    );

    const finalStatus = (statusPayload.status || statusPayload.state || '').toLowerCase();
    expect(['sent', 'delivered', 'dead_letter']).toContain(finalStatus);

    if (finalStatus !== 'dead_letter') {
      test.info().annotations.push({ type: 'delivery-retry', description: 'Message recovered on retry' });
    } else {
      expect(statusPayload.attempts || statusPayload.retries || 0).toBeGreaterThanOrEqual(2);
    }
  });
});
