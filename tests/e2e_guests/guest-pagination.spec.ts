import { expect, test } from '@playwright/test';
import { seeds } from '../fixtures/datasets';
import { getJSON } from '../fixtures/http';

const defaultEventId = process.env.E2E_EVENT_ID || seeds.delivery.eventId || 'demo-event';

function normalizeGuestsPayload(payload: unknown) {
  if (!payload) return [] as any[];
  if (Array.isArray(payload)) return payload as any[];
  if (typeof payload === 'object' && Array.isArray((payload as any).guests)) {
    return (payload as any).guests as any[];
  }
  return [] as any[];
}

function extractGuestId(guest: any): string {
  if (!guest || typeof guest !== 'object') return '';
  if (typeof guest.id === 'string') return guest.id;
  if (typeof guest.guestId === 'string') return guest.guestId;
  if (typeof guest.phone === 'string') return `${guest.eventId || ''}-${guest.phone}`;
  return JSON.stringify(guest);
}

test.describe('@guests pagination and filtering', () => {
  test('@guests should paginate event guests with stable ordering', async ({ request }) => {
    const limit = 5;
    const firstResponse = await getJSON(
      request,
      `/events/${encodeURIComponent(defaultEventId)}/guests`,
      { query: { limit: String(limit), offset: '0' } },
    );
    expect(firstResponse.ok(), 'first page response ok').toBeTruthy();
    const firstPayload = await firstResponse.json();
    const firstGuests = normalizeGuestsPayload(firstPayload);
    expect(firstGuests.length, 'first page should include guests').toBeGreaterThan(0);
    if (firstGuests.length < limit) {
      test.skip(true, 'Not enough guests for pagination checks');
      return;
    }

    const secondResponse = await getJSON(
      request,
      `/events/${encodeURIComponent(defaultEventId)}/guests`,
      { query: { limit: String(limit), offset: String(limit) } },
    );
    expect(secondResponse.ok(), 'second page response ok').toBeTruthy();
    const secondPayload = await secondResponse.json();
    const secondGuests = normalizeGuestsPayload(secondPayload);
    expect(secondGuests.length, 'second page should include guests').toBeGreaterThan(0);

    const aggregated = [...firstGuests, ...secondGuests];
    const aggregatedIds = aggregated.map(extractGuestId);
    expect(new Set(aggregatedIds).size).toBe(aggregatedIds.length);

    const referenceResponse = await getJSON(
      request,
      `/events/${encodeURIComponent(defaultEventId)}/guests`,
      { query: { limit: String(limit * 2), offset: '0' } },
    );
    expect(referenceResponse.ok(), 'combined page response ok').toBeTruthy();
    const referencePayload = await referenceResponse.json();
    const referenceGuests = normalizeGuestsPayload(referencePayload);
    expect(referenceGuests.length).toBeGreaterThanOrEqual(aggregatedIds.length);

    const referenceIds = referenceGuests.slice(0, aggregatedIds.length).map(extractGuestId);
    expect(referenceIds).toEqual(aggregatedIds);
  });

  test('@guests should filter event guests by status', async ({ request }) => {
    const response = await getJSON(
      request,
      `/events/${encodeURIComponent(defaultEventId)}/guests`,
      { query: { status: 'pending', limit: '20' } },
    );
    expect(response.ok(), 'status filter response ok').toBeTruthy();
    const payload = await response.json();
    const guests = normalizeGuestsPayload(payload);
    expect(guests.length, 'status filter should return guests').toBeGreaterThan(0);
    for (const guest of guests) {
      expect(guest.status).toBe('pending');
    }
  });

  test('@guests should paginate global guest listing consistently', async ({ request }) => {
    const limit = 6;
    const firstResponse = await getJSON(request, '/guests', {
      query: { limit: String(limit), offset: '0' },
    });
    expect(firstResponse.ok(), 'global first page ok').toBeTruthy();
    const firstPayload = await firstResponse.json();
    const firstGuests = normalizeGuestsPayload(firstPayload);
    expect(firstGuests.length, 'global first page should have guests').toBeGreaterThan(0);
    if (firstGuests.length < limit) {
      test.skip(true, 'Not enough global guests for pagination checks');
      return;
    }

    const secondResponse = await getJSON(request, '/guests', {
      query: { limit: String(limit), offset: String(limit) },
    });
    expect(secondResponse.ok(), 'global second page ok').toBeTruthy();
    const secondPayload = await secondResponse.json();
    const secondGuests = normalizeGuestsPayload(secondPayload);
    expect(secondGuests.length, 'global second page should have guests').toBeGreaterThan(0);

    const aggregated = [...firstGuests, ...secondGuests];
    const aggregatedIds = aggregated.map(extractGuestId);
    expect(new Set(aggregatedIds).size).toBe(aggregatedIds.length);

    const referenceResponse = await getJSON(request, '/guests', {
      query: { limit: String(limit * 2), offset: '0' },
    });
    expect(referenceResponse.ok(), 'global combined page ok').toBeTruthy();
    const referencePayload = await referenceResponse.json();
    const referenceGuests = normalizeGuestsPayload(referencePayload);
    expect(referenceGuests.length).toBeGreaterThanOrEqual(aggregatedIds.length);

    const referenceIds = referenceGuests.slice(0, aggregatedIds.length).map(extractGuestId);
    expect(referenceIds).toEqual(aggregatedIds);
  });
});
