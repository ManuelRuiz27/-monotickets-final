'use client';

import { handleError } from '@shared/api/errors';
import { getSession } from '../auth/session';

export type PaymentStatus = 'pending' | 'paid' | 'failed';

export interface DirectorOverview {
  eventsByType: {
    standard: number;
    premium: number;
  };
  activeOrganizers: number;
  ticketsGenerated: number;
  updatedAt: string;
  totals: {
    revenue: number;
    outstanding: number;
    commissions: number;
    currency: string;
  };
  paymentSummary: {
    pending: number;
    paid: number;
    failed: number;
  };
  recentPayments: PaymentRecord[];
}

export interface OrganizerRecord {
  id: string;
  name: string;
  email: string;
  phone?: string;
  plan: string;
  ticketsGenerated: number;
  outstandingBalance: number;
  currency: string;
  pricePerTicket?: number;
  balance?: number;
}

export interface ReceivableRecord {
  organizerId: string;
  organizerName: string;
  amount: number;
  currency: string;
  agingBucket: '0-30' | '31-60' | '61-90' | '90+';
  lastPaymentAt?: string;
  lastMovementNote?: string;
}

export interface PaymentRecord {
  id: string;
  organizerId: string;
  organizerName: string;
  amount: number;
  currency: string;
  method: string;
  reference?: string;
  note?: string;
  status: PaymentStatus;
  paidAt: string;
  createdAt: string;
}

export interface KpiOverview {
  ticketsGenerated: number;
  activeCustomers: number;
  outstandingDebt: number;
  recentPayments: PaymentRecord[];
}

export interface GrantPayload {
  type: 'prepaid' | 'loan';
  tickets: number;
  reference?: string;
}

export interface PaymentPayload {
  organizerId: string;
  amount: number;
  currency: string;
  method: string;
  paidAt: string;
  note?: string;
  reference?: string;
}

export interface PricingPayload {
  price: number;
  currency: string;
}

export type PricingUpdatePayload = PricingPayload;

const API_BASE =
  process.env.DASHBOARD_NEXT_PUBLIC_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  '';

const USE_MOCK = !API_BASE;

const MOCK_OVERVIEW: DirectorOverview = {
  eventsByType: {
    standard: 12,
    premium: 5,
  },
  activeOrganizers: 8,
  ticketsGenerated: 4380,
  updatedAt: new Date().toISOString(),
  totals: {
    revenue: 0,
    outstanding: 0,
    commissions: 0,
    currency: 'MXN',
  },
  paymentSummary: {
    pending: 0,
    paid: 0,
    failed: 0,
  },
  recentPayments: [],
};

const MOCK_ORGANIZERS: OrganizerRecord[] = [
  {
    id: 'org-aurora',
    name: 'Experiencias Aurora',
    email: 'gerencia@aurora.mx',
    phone: '+52 55 1000 0001',
    plan: 'Premium',
    ticketsGenerated: 1820,
    outstandingBalance: 12500,
    currency: 'MXN',
    pricePerTicket: 9.5,
    balance: 12500,
  },
  {
    id: 'org-momentum',
    name: 'Momentum Eventos',
    email: 'hola@momentum.mx',
    phone: '+52 33 9000 0002',
    plan: 'Standard',
    ticketsGenerated: 980,
    outstandingBalance: 0,
    currency: 'MXN',
    pricePerTicket: 7.5,
    balance: 0,
  },
  {
    id: 'org-summit',
    name: 'Summit Riviera',
    email: 'contacto@summit.mx',
    plan: 'Growth',
    ticketsGenerated: 620,
    outstandingBalance: 4200,
    currency: 'MXN',
    balance: 4200,
  },
];

const MOCK_RECEIVABLES: ReceivableRecord[] = [
  {
    organizerId: 'org-aurora',
    organizerName: 'Experiencias Aurora',
    amount: 8200,
    currency: 'MXN',
    agingBucket: '31-60',
    lastPaymentAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 22).toISOString(),
    lastMovementNote: 'Liquidó preventa parcial',
  },
  {
    organizerId: 'org-summit',
    organizerName: 'Summit Riviera',
    amount: 4200,
    currency: 'MXN',
    agingBucket: '0-30',
    lastPaymentAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 10).toISOString(),
  },
];

const MOCK_PAYMENTS: PaymentRecord[] = [
  {
    id: 'pay-001',
    organizerId: 'org-aurora',
    organizerName: 'Experiencias Aurora',
    amount: 7500,
    currency: 'MXN',
    method: 'transferencia',
    reference: 'FACT-2024-021',
    status: 'paid',
    note: 'Liquidación parcial Q1',
    paidAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 12).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 12).toISOString(),
  },
  {
    id: 'pay-002',
    organizerId: 'org-momentum',
    organizerName: 'Momentum Eventos',
    amount: 3200,
    currency: 'MXN',
    method: 'tarjeta',
    reference: 'FACT-2024-014',
    status: 'paid',
    paidAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
  },
];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (USE_MOCK) {
    return mockRequest<T>(path, init);
  }

  const session = getSession();
  const headers = new Headers(init?.headers ?? {});
  headers.set('Content-Type', 'application/json');
  if (session?.accessToken) {
    headers.set('Authorization', `Bearer ${session.accessToken}`);
  }
  if (session?.staffToken) {
    headers.set('x-staff-token', session.staffToken);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });

  if (!res.ok) {
    await handleError(res, { scope: 'director-api', request: path });
  }

  return res.json() as Promise<T>;
}

function mockRequest<T>(path: string, init?: RequestInit): T {
  const url = new URL(path, 'https://mock.monotickets.local');
  const { pathname, searchParams } = url;

  if (pathname === '/director/overview') {
    const totals = computeTotals();
    const summary = computePaymentSummary();
    const overview: DirectorOverview = {
      ...MOCK_OVERVIEW,
      updatedAt: new Date().toISOString(),
      totals,
      paymentSummary: summary,
      recentPayments: MOCK_PAYMENTS.slice(0, 5),
    };
    return clone(overview) as T;
  }

  if (pathname === '/director/organizers') {
    const query = (searchParams.get('q') ?? '').toLowerCase();
    const filtered = query
      ? MOCK_ORGANIZERS.filter((organizer) =>
          [organizer.name, organizer.email, organizer.phone].some((field) =>
            (field ?? '').toLowerCase().includes(query)
          )
        )
      : MOCK_ORGANIZERS;
    return clone(filtered) as T;
  }

  if (pathname.startsWith('/director/organizers/') && pathname.endsWith('/tickets/grant')) {
    const organizerId = pathname.split('/')[3];
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    const organizer = MOCK_ORGANIZERS.find((item) => item.id === organizerId);
    if (organizer) {
      const tickets = Number(payload.tickets ?? 0);
      const price = organizer.pricePerTicket ?? 0;
      const impact = tickets * price;
      if (payload.type === 'prepaid') {
        organizer.outstandingBalance = Math.max(0, (organizer.outstandingBalance ?? 0) - impact);
      } else {
        organizer.outstandingBalance = (organizer.outstandingBalance ?? 0) + impact;
      }
    }
    return { granted: payload.tickets ?? 0 } as T;
  }

  if (pathname.startsWith('/director/organizers/') && pathname.endsWith('/payments')) {
    return { balance: 0 } as T;
  }

  if (pathname.startsWith('/director/organizers/') && pathname.endsWith('/pricing')) {
    const organizerId = pathname.split('/')[3];
    const payload = init?.body ? JSON.parse(String(init.body)) : {};
    const organizer = MOCK_ORGANIZERS.find((item) => item.id === organizerId);
    if (organizer && typeof payload.price === 'number') {
      organizer.pricePerTicket = payload.price;
    }
    return clone(organizer ?? MOCK_ORGANIZERS[0]) as T;
  }

  if (pathname === '/director/receivables') {
    const bucket = searchParams.get('aging') as ReceivableRecord['agingBucket'] | null;
    const filtered = bucket ? MOCK_RECEIVABLES.filter((item) => item.agingBucket === bucket) : MOCK_RECEIVABLES;
    return clone(filtered) as T;
  }

  if (pathname === '/director/payments' && (!init?.method || init.method === 'GET')) {
    const organizerId = searchParams.get('organizerId');
    const status = searchParams.get('status') as PaymentStatus | null;
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const filtered = MOCK_PAYMENTS.filter((payment) => {
      if (organizerId && payment.organizerId !== organizerId) return false;
      if (status && payment.status !== status) return false;
      if (from && new Date(payment.paidAt) < new Date(from)) return false;
      if (to && new Date(payment.paidAt) > new Date(to + 'T23:59:59')) return false;
      return true;
    });
    return clone(filtered) as T;
  }

  if (pathname === '/director/payments' && init?.method === 'POST') {
    const payload = init.body ? JSON.parse(String(init.body)) : {};
    const organizer = MOCK_ORGANIZERS.find((item) => item.id === payload.organizerId);
    const record: PaymentRecord = {
      id: `pay-${Date.now()}`,
      organizerId: payload.organizerId ?? 'organizador-demo',
      organizerName: organizer?.name ?? 'Organizador demo',
      amount: Number(payload.amount ?? 0),
      currency: payload.currency ?? 'MXN',
      method: payload.method ?? 'transferencia',
      reference: payload.reference ?? `REF-${Date.now()}`,
      note: payload.note ?? '',
      status: 'paid',
      paidAt: payload.paidAt ?? new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    MOCK_PAYMENTS.unshift(record);
    const receivable = MOCK_RECEIVABLES.find((item) => item.organizerId === record.organizerId);
    if (receivable) {
      receivable.amount = Math.max(0, receivable.amount - record.amount);
      if (receivable.amount === 0) {
        const index = MOCK_RECEIVABLES.indexOf(receivable);
        MOCK_RECEIVABLES.splice(index, 1);
      }
    }
    return clone(record) as T;
  }

  if (pathname === '/director/kpis') {
    const outstanding = MOCK_RECEIVABLES.reduce((sum, item) => sum + item.amount, 0);
    const overview: KpiOverview = {
      ticketsGenerated: MOCK_OVERVIEW.ticketsGenerated,
      activeCustomers: MOCK_ORGANIZERS.length,
      outstandingDebt: outstanding,
      recentPayments: MOCK_PAYMENTS.slice(0, 4),
    };
    return clone(overview) as T;
  }

  throw new Error(`Mock director API: ruta no soportada (${pathname})`);
}

export function getDirectorOverview() {
  return request<DirectorOverview>('/director/overview');
}

export function getDirectorOrganizers(query?: string) {
  const search = query ? `?q=${encodeURIComponent(query)}` : '';
  return request<OrganizerRecord[]>(`/director/organizers${search}`);
}

export function getKpiOverview() {
  return request<KpiOverview>('/director/kpis');
}

export function grantTickets(organizerId: string, payload: GrantPayload | number) {
  const body = typeof payload === 'number' ? { type: 'prepaid', tickets: payload } : payload;
  return request<{ granted: number }>(`/director/organizers/${organizerId}/tickets/grant`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface PaymentFilters {
  organizerId?: string;
  status?: PaymentStatus;
  from?: string;
  to?: string;
}

export function getPayments(filters: PaymentFilters = {}) {
  const params = new URLSearchParams();
  if (filters.organizerId) params.set('organizerId', filters.organizerId);
  if (filters.status) params.set('status', filters.status);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const suffix = params.size ? `?${params.toString()}` : '';
  return request<PaymentRecord[]>(`/director/payments${suffix}`);
}

export function createPayment(payload: PaymentPayload) {
  return request<PaymentRecord>('/director/payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function recordPayment(organizerId: string, payload: PaymentPayload) {
  return request<{ balance: number }>(`/director/organizers/${organizerId}/payments`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updatePricing(organizerId: string, payload: PricingPayload) {
  return request<OrganizerRecord>(`/director/organizers/${organizerId}/pricing`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function getReceivables(aging?: ReceivableRecord['agingBucket']) {
  const query = aging ? `?aging=${encodeURIComponent(aging)}` : '';
  return request<ReceivableRecord[]>(`/director/receivables${query}`);
}

function clone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function computeTotals() {
  const revenue = MOCK_PAYMENTS.filter((payment) => payment.status === 'paid').reduce((sum, payment) => sum + payment.amount, 0);
  const outstanding = MOCK_RECEIVABLES.reduce((sum, item) => sum + item.amount, 0);
  const commissions = Number((revenue * 0.08).toFixed(2));
  return {
    revenue,
    outstanding,
    commissions,
    currency: 'MXN',
  };
}

function computePaymentSummary() {
  return {
    pending: MOCK_PAYMENTS.filter((payment) => payment.status === 'pending').length,
    paid: MOCK_PAYMENTS.filter((payment) => payment.status === 'paid').length,
    failed: MOCK_PAYMENTS.filter((payment) => payment.status === 'failed').length,
  };
}
