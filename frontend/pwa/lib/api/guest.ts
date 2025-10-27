export type InviteTemplateKind = 'standard' | 'premium';
export type GuestStatus = 'pending' | 'confirmed' | 'scanned';

export interface EventTheme {
  primaryColor?: string;
  secondaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  accentColor?: string;
  headingFont?: string;
  bodyFont?: string;
}

export interface GuestSummary {
  name: string;
  status: GuestStatus;
  confirmationUrl: string;
}

export interface EventSummary {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  startDate: string;
  endDate?: string | null;
  timezone?: string | null;
  location?: string;
  coverImageUrl?: string;
  coverAlt?: string;
  logoUrl?: string;
  calendarDescription?: string;
}

export interface TemplateLinks {
  pdfUrl?: string;
  flipbookUrl?: string;
  thumbnailUrl?: string;
}

export interface InviteResponse {
  code: string;
  guest: GuestSummary;
  event: EventSummary;
  template: InviteTemplateKind;
  theme?: EventTheme;
  templateLinks?: TemplateLinks;
  qr?: {
    imageUrl: string;
    altText: string;
    instructions?: string;
  };
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const USE_MOCK = !API_BASE;

const QR_PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" role="img" aria-label="Código QR simulado"><rect width="80" height="80" fill="#0f172a"/><rect x="8" y="8" width="22" height="22" fill="#f8fafc"/><rect x="50" y="8" width="22" height="22" fill="#f8fafc"/><rect x="8" y="50" width="22" height="22" fill="#f8fafc"/><rect x="24" y="24" width="32" height="32" fill="#f8fafc"/></svg>`
  );

const FALLBACK_INVITES: Record<string, InviteResponse> = {
  'demo-confirmed': {
    code: 'demo-confirmed',
    guest: {
      name: 'Ada Lovelace',
      status: 'confirmed',
      confirmationUrl: '#',
    },
    event: {
      id: 'gala-innovacion-2024',
      title: 'Gala Innovación 2024',
      subtitle: 'Experiencia inmersiva para organizadores',
      description:
        'Programa ejecutivo con keynotes, showcases y mesas de trabajo centradas en automatización de eventos.',
      startDate: new Date(Date.now() + 3600 * 1000 * 72).toISOString(),
      endDate: new Date(Date.now() + 3600 * 1000 * 78).toISOString(),
      timezone: 'America/Mexico_City',
      location: 'Auditorio Reforma · CDMX',
      coverImageUrl: 'https://images.unsplash.com/photo-1545239351-1141bd82e8a6?auto=format&fit=crop&w=1200&q=80',
      coverAlt: 'Personas celebrando en un evento con luces azules',
      logoUrl: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=600&q=80',
      calendarDescription: 'Añade a tu calendario: Gala Innovación 2024 organizada por Experiencias Aurora.',
    },
    template: 'premium',
    theme: {
      primaryColor: '#6366f1',
      secondaryColor: '#312e81',
      backgroundColor: '#eef2ff',
      textColor: '#0f172a',
      accentColor: '#22c55e',
      headingFont: `'Poppins', system-ui, sans-serif`,
      bodyFont: `'Inter', system-ui, sans-serif`,
    },
    templateLinks: {
      pdfUrl: '#',
      flipbookUrl: '#',
      thumbnailUrl: 'https://images.unsplash.com/photo-1545239351-1141bd82e8a6?auto=format&fit=crop&w=400&q=60',
    },
    qr: {
      imageUrl: QR_PLACEHOLDER,
      altText: 'QR de demostración',
      instructions: 'Muestra el código desde tu dispositivo al llegar al evento. Si tienes sesión de WhatsApp abierta tu check-in es más rápido.',
    },
  },
  'demo-pending': {
    code: 'demo-pending',
    guest: {
      name: 'Grace Hopper',
      status: 'pending',
      confirmationUrl: '#',
    },
    event: {
      id: 'summit-premium-riviera',
      title: 'Summit Premium Riviera',
      subtitle: 'Todo sobre analítica en la industria del entretenimiento.',
      description:
        'Sesiones clave para dominar la analítica de invitados, automatización de colas y comparativas de KPIs ejecutivos.',
      startDate: new Date(Date.now() + 3600 * 1000 * 120).toISOString(),
      endDate: new Date(Date.now() + 3600 * 1000 * 132).toISOString(),
      timezone: 'America/Mexico_City',
      location: 'Foro Digital · CDMX',
      calendarDescription: 'Recordatorio: confirma asistencia para reservar alojamiento y sesiones privadas.',
    },
    template: 'standard',
    templateLinks: {
      pdfUrl: '#',
      thumbnailUrl: 'https://images.unsplash.com/photo-1551836022-deb4988cc6c7?auto=format&fit=crop&w=400&q=60',
    },
  },
  'demo-scanned': {
    code: 'demo-scanned',
    guest: {
      name: 'Alan Turing',
      status: 'scanned',
      confirmationUrl: '#',
    },
    event: {
      id: 'after-office-backstage',
      title: 'After Office Backstage',
      subtitle: 'Sesión exclusiva para invitados VIP.',
      description: 'Networking y celebración posterior al evento principal con stands interactivos.',
      startDate: new Date(Date.now() - 3600 * 1000 * 1).toISOString(),
      endDate: new Date(Date.now() + 3600 * 1000 * 2).toISOString(),
      location: 'Sala VIP, Auditorio Reforma',
      timezone: 'America/Mexico_City',
    },
    template: 'premium',
    theme: {
      primaryColor: '#0f172a',
      secondaryColor: '#9333ea',
      backgroundColor: '#fdf2f8',
      textColor: '#1f2937',
    },
    qr: {
      imageUrl: QR_PLACEHOLDER,
      altText: 'QR utilizado (demostración)',
      instructions: 'Este QR ya fue validado en el acceso principal. Solicita asistencia si necesitas reingresar.',
    },
  },
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (USE_MOCK) {
    return mockRequest<T>(path, init);
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Guest API request failed (${response.status} ${response.statusText}): ${detail}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[guest-api] falling back to mock data for', path, error);
    }
    return mockRequest<T>(path, init);
  }
}

function mockRequest<T>(path: string, init?: RequestInit): T {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(normalizedPath, 'https://mock.monotickets.local');
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] === 'public') {
    segments.shift();
  }

  if (segments[0] === 'guest' && segments[1] === 'invites') {
    // Compatibilidad con rutas anteriores
    segments.shift();
    segments.shift();
    segments.unshift('invite');
  }

  const [resource, codeSegment, extra] = segments;

  if (!resource || !codeSegment) {
    throw new Error(`Mock API: ruta no soportada (${path})`);
  }

  if (resource === 'invite') {
    const code = decodeURIComponent(codeSegment);
    const invite = FALLBACK_INVITES[code];
    if (!invite) {
      throw new Error(`Mock API: invitación ${code} no encontrada`);
    }

    if (!extra) {
      return deepClone(invite) as T;
    }

    if (extra === 'qr') {
      return {
        status: invite.guest.status,
        qr: invite.qr,
      } as T;
    }
  }

  if (resource === 'confirm') {
    const code = decodeURIComponent(codeSegment);
    const invite = FALLBACK_INVITES[code];
    if (!invite) {
      throw new Error(`Mock API: invitación ${code} no encontrada`);
    }

    if (init?.method === 'POST' || init?.method === 'PUT' || init?.method === 'PATCH') {
      invite.guest.status = 'confirmed';
      invite.qr =
        invite.qr ??
        ({
          imageUrl: QR_PLACEHOLDER,
          altText: 'QR confirmado',
        } as InviteResponse['qr']);

      return {
        status: 'confirmed',
        redirectUrl: `/invite/${code}/qr`,
        qr: invite.qr,
      } as T;
    }

    return {
      status: invite.guest.status,
      qr: invite.qr,
    } as T;
  }

  throw new Error(`Mock API: recurso ${segments.join('/')} no soportado`);
}

export function getInvite(code: string) {
  return request<InviteResponse>(`/public/invite/${encodeURIComponent(code)}`);
}

export async function getInviteLanding(code: string) {
  const invite = await getInvite(code);
  return invite;
}

export async function getTemplateLinks(code: string) {
  const invite = await getInvite(code);
  return invite.templateLinks ?? { pdfUrl: undefined, flipbookUrl: undefined };
}

export async function getLandingKind(code: string) {
  const invite = await getInvite(code);
  return invite.template;
}

export async function confirmAttendance(code: string) {
  try {
    return await request<{ status: GuestStatus; redirectUrl?: string; qr?: InviteResponse['qr'] }>(
      `/public/confirm/${encodeURIComponent(code)}`,
      {
        method: 'POST',
      }
    );
  } catch (error) {
    return request<{ status: GuestStatus; redirectUrl?: string; qr?: InviteResponse['qr'] }>(
      `/public/confirm/${encodeURIComponent(code)}`
    );
  }
}

export async function getInviteQr(code: string) {
  try {
    return await request<{ status: GuestStatus; qr?: InviteResponse['qr'] }>(
      `/public/invite/${encodeURIComponent(code)}/qr`
    );
  } catch (error) {
    const invite = await getInvite(code);
    return { status: invite.guest.status, qr: invite.qr };
  }
}

function deepClone<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}
