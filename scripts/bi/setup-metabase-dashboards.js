#!/usr/bin/env node
/*
 * Script to bootstrap Metabase dashboards for Monotickets BI
 */

require('dotenv').config();
const crypto = require('crypto');

const env = process.env;
const SITE_URL = env.METABASE_SITE_URL;
const DATABASE_ID = env.METABASE_DATABASE_ID;
const ORGANIZER_GROUP_ID = env.METABASE_ORGANIZER_GROUP_ID;
const DIRECTOR_GROUP_ID = env.METABASE_DIRECTOR_GROUP_ID;
const PARENT_COLLECTION_NAME = env.METABASE_COLLECTION_NAME || 'Monotickets – Dashboards';

if (!SITE_URL) {
  console.error('Missing METABASE_SITE_URL environment variable.');
  process.exit(1);
}

if (!DATABASE_ID) {
  console.error('Missing METABASE_DATABASE_ID environment variable.');
  process.exit(1);
}

let sessionToken = env.METABASE_SESSION_TOKEN || null;

async function loginIfNeeded() {
  if (sessionToken) {
    return;
  }

  const username = env.METABASE_USERNAME || env.METABASE_EMAIL;
  const password = env.METABASE_PASSWORD;

  if (!username || !password) {
    console.error('Provide either METABASE_SESSION_TOKEN or METABASE_USERNAME/METABASE_PASSWORD credentials.');
    process.exit(1);
  }

  const res = await fetchJson('/api/session', {
    method: 'POST',
    body: { username, password },
    authenticate: false,
  });

  sessionToken = res.id;
  if (!sessionToken) {
    console.error('Could not retrieve Metabase session token.');
    process.exit(1);
  }
  console.log('Authenticated against Metabase API.');
}

async function fetchJson(path, options = {}) {
  const { method = 'GET', body, authenticate = true, headers = {} } = options;
  const url = `${SITE_URL}${path}`;

  const finalHeaders = { ...headers };
  if (authenticate && sessionToken) {
    finalHeaders['X-Metabase-Session'] = sessionToken;
  }
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers: finalHeaders,
    body: payload,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Metabase request failed: ${method} ${path} -> ${response.status}\n${text}`);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

async function ensureCollection(name, description = '', parentId = null) {
  const collections = await fetchJson('/api/collection');
  let existing = collections.find(
    (col) => col.name === name && (col.parent_id === parentId || (!col.parent_id && !parentId))
  );

  if (existing) {
    if (description && existing.description !== description) {
      await fetchJson(`/api/collection/${existing.id}`, {
        method: 'PUT',
        body: { ...existing, description },
      });
      existing.description = description;
    }
    return existing;
  }

  const payload = {
    name,
    description,
  };
  if (parentId) {
    payload.parent_id = parentId;
  }

  const created = await fetchJson('/api/collection', {
    method: 'POST',
    body: payload,
  });
  console.log(`Created collection "${name}" (id ${created.id}).`);
  return created;
}

async function findItemInCollection(collectionId, name, model) {
  const data = await fetchJson(`/api/collection/${collectionId}/items?limit=200`);
  if (!Array.isArray(data?.data)) {
    return null;
  }
  const item = data.data.find((entry) => entry.name === name && entry.model === model);
  return item || null;
}

async function upsertCard(collectionId, cardDef) {
  const existing = await findItemInCollection(collectionId, cardDef.name, 'card');
  const payload = {
    name: cardDef.name,
    dataset_query: cardDef.dataset_query,
    display: cardDef.display,
    visualization_settings: cardDef.visualization_settings || {},
    description: cardDef.description || '',
    collection_id: collectionId,
  };

  if (cardDef.result_metadata) {
    payload.result_metadata = cardDef.result_metadata;
  }

  if (existing) {
    const updated = await fetchJson(`/api/card/${existing.id}`, {
      method: 'PUT',
      body: { ...payload, id: existing.id },
    });
    console.log(`Updated card "${cardDef.name}" (id ${existing.id}).`);
    return updated;
  }

  const created = await fetchJson('/api/card', {
    method: 'POST',
    body: payload,
  });
  console.log(`Created card "${cardDef.name}" (id ${created.id}).`);
  return created;
}

async function deleteExistingDashcards(dashboardId) {
  const dashboard = await fetchJson(`/api/dashboard/${dashboardId}`);
  if (!dashboard?.dashcards) {
    return;
  }
  for (const dashcard of dashboard.dashcards) {
    await fetchJson(`/api/dashboard/${dashboardId}/cards/${dashcard.id}`, {
      method: 'DELETE',
    });
  }
}

async function upsertDashboard(collectionId, def) {
  const dashboards = await fetchJson('/api/dashboard?limit=200');
  let existing = dashboards.find((db) => db.name === def.name && db.collection_id === collectionId);

  const dashboardPayload = {
    name: def.name,
    description: def.description || '',
    parameters: def.parameters || [],
    collection_id: collectionId,
  };

  if (existing) {
    await fetchJson(`/api/dashboard/${existing.id}`, {
      method: 'PUT',
      body: { ...dashboardPayload, id: existing.id },
    });
    console.log(`Updated dashboard "${def.name}" (id ${existing.id}).`);
  } else {
    existing = await fetchJson('/api/dashboard', {
      method: 'POST',
      body: dashboardPayload,
    });
    console.log(`Created dashboard "${def.name}" (id ${existing.id}).`);
  }

  await deleteExistingDashcards(existing.id);

  for (const dashcard of def.dashcards) {
    const payload = {
      cardId: dashcard.card_id || dashcard.cardId || null,
      row: dashcard.row || 0,
      col: dashcard.col || 0,
      sizeX: dashcard.sizeX || dashcard.size_x || 6,
      sizeY: dashcard.sizeY || dashcard.size_y || 6,
      visualization_settings: dashcard.visualization_settings || {},
      parameter_mappings: dashcard.parameter_mappings || [],
    };
    if (dashcard.text) {
      payload.visualization_settings = {
        text: dashcard.text,
        background: 'none',
        size: 'auto',
        ...payload.visualization_settings,
      };
      payload.parameter_mappings = [];
      payload.cardId = null;
    }
    await fetchJson(`/api/dashboard/${existing.id}/cards`, {
      method: 'POST',
      body: payload,
    });
  }

  return existing;
}

async function assignCollectionPermissions(collectionId) {
  if (!ORGANIZER_GROUP_ID && !DIRECTOR_GROUP_ID) {
    return;
  }

  try {
    const body = {
      id: collectionId,
      groups: {},
    };
    if (ORGANIZER_GROUP_ID) {
      body.groups[ORGANIZER_GROUP_ID] = 'read';
    }
    if (DIRECTOR_GROUP_ID) {
      body.groups[DIRECTOR_GROUP_ID] = 'read';
    }
    await fetchJson(`/api/permissions/collection/${collectionId}`, {
      method: 'PUT',
      body,
    });
    console.log(`Updated collection permissions (id ${collectionId}).`);
  } catch (error) {
    console.warn(`Could not update collection permissions: ${error.message}`);
  }
}

async function getDatabaseMetadata() {
  const metadata = await fetchJson(`/api/database/${DATABASE_ID}/metadata`);
  if (!metadata?.tables) {
    throw new Error(`Unable to load metadata for database ${DATABASE_ID}.`);
  }
  return metadata;
}

function findFieldId(metadata, tableName, fieldName) {
  const table = metadata.tables.find((tbl) => tbl.name === tableName);
  if (!table) {
    throw new Error(`Table or view "${tableName}" not found in metadata.`);
  }
  const field = table.fields.find((fld) => fld.name === fieldName);
  if (!field) {
    throw new Error(`Field "${fieldName}" not found in table "${tableName}".`);
  }
  return field.id;
}

function templateTag({ id, name, displayName, fieldId, widgetType = 'category' }) {
  return {
    id,
    name,
    'display-name': displayName,
    type: 'dimension',
    dimension: ['field', ['field-id', fieldId]],
    'widget-type': widgetType,
  };
}

function buildDashboardParameters({ eventTagId, organizerTagId }) {
  return [
    {
      name: 'Evento',
      slug: 'evento',
      id: eventTagId,
      type: 'category',
    },
    {
      name: 'Organizador',
      slug: 'organizador',
      id: organizerTagId,
      type: 'category',
    },
  ];
}

function mapping(parameterId, templateTagId, cardId) {
  const result = {
    parameter_id: parameterId,
    target: ['dimension', ['template-tag', templateTagId]],
  };
  if (cardId) {
    result.card_id = cardId;
  }
  return result;
}

async function main() {
  await loginIfNeeded();
  const metadata = await getDatabaseMetadata();
  const eventIdFieldId = findFieldId(metadata, 'events', 'id');
  const organizerFieldId = findFieldId(metadata, 'events', 'organizer_id');

  const confirmationEventFieldId = findFieldId(metadata, 'mv_confirmation_rate_daily', 'event_id');
  const showupEventFieldId = findFieldId(metadata, 'mv_show_up_rate_daily', 'event_id');
  const waEventFieldId = findFieldId(metadata, 'mv_wa_free_ratio_daily', 'event_id');
  const debtOrganizerFieldId = findFieldId(metadata, 'mv_organizer_debt', 'organizer_id');

  const eventTemplate = templateTag({
    id: 'event_id',
    name: 'event_id',
    displayName: 'Evento',
    fieldId: eventIdFieldId,
  });
  const organizerTemplate = templateTag({
    id: 'organizer_id',
    name: 'organizer_id',
    displayName: 'Organizador',
    fieldId: organizerFieldId,
  });

  const parentCollection = await ensureCollection(
    PARENT_COLLECTION_NAME,
    'Dashboards operativos y ejecutivos generados automáticamente para Monotickets.'
  );

  const organizerCollection = await ensureCollection(
    'Organizer – Operación',
    'Colección base de KPIs diarios para organizadores.',
    parentCollection.id
  );

  const directorCollection = await ensureCollection(
    'Director – Ejecutivo',
    'KPIs de dirección (mix de eventos, organizadores activos y deuda abierta).',
    parentCollection.id
  );

  const organizerCards = await Promise.all([
    upsertCard(organizerCollection.id, {
      name: 'Confirmación hoy',
      display: 'scalar',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  COALESCE(ROUND(100.0 * SUM(m.confirmed) / NULLIF(SUM(m.total), 0), 2), 0) AS confirmation_rate\nFROM mv_confirmation_rate_daily m\nJOIN events e ON e.id = m.event_id\nWHERE m.day = current_date\n[[AND m.event_id = {{event_id}}]]\n[[AND e.organizer_id = {{organizer_id}}]];`,
          'template-tags': {
            event_id: eventTemplate,
            organizer_id: organizerTemplate,
          },
        },
      },
      visualization_settings: {
        'card.title': 'Confirmación hoy (%)',
        'scalar.field': 'confirmation_rate',
      },
    }),
    upsertCard(organizerCollection.id, {
      name: 'Show-up hoy',
      display: 'scalar',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  COALESCE(ROUND(100.0 * SUM(s.scanned) / NULLIF(SUM(s.confirmed), 0), 2), 0) AS show_up_rate\nFROM mv_show_up_rate_daily s\nJOIN events e ON e.id = s.event_id\nWHERE s.day = current_date\n[[AND s.event_id = {{event_id}}]]\n[[AND e.organizer_id = {{organizer_id}}]];`,
          'template-tags': {
            event_id: { ...eventTemplate, dimension: ['field', ['field-id', showupEventFieldId]] },
            organizer_id: organizerTemplate,
          },
        },
      },
      visualization_settings: {
        'card.title': 'Show-up hoy (%)',
        'scalar.field': 'show_up_rate',
      },
    }),
    upsertCard(organizerCollection.id, {
      name: 'Ratio WA gratuito 24h',
      display: 'scalar',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  COALESCE(ROUND(100.0 * SUM(w.free_wa) / NULLIF(SUM(w.total_wa), 0), 2), 0) AS wa_free_ratio\nFROM mv_wa_free_ratio_daily w\nJOIN events e ON e.id = w.event_id\nWHERE w.day >= current_date - interval '1 day'\n[[AND w.event_id = {{event_id}}]]\n[[AND e.organizer_id = {{organizer_id}}]];`,
          'template-tags': {
            event_id: { ...eventTemplate, dimension: ['field', ['field-id', waEventFieldId]] },
            organizer_id: organizerTemplate,
          },
        },
      },
      visualization_settings: {
        'card.title': 'Ratio WA gratuito (24h)',
        'scalar.field': 'wa_free_ratio',
      },
    }),
    upsertCard(organizerCollection.id, {
      name: 'Confirmación últimos 7 días',
      display: 'line',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  m.day,\n  ROUND(100.0 * SUM(m.confirmed) / NULLIF(SUM(m.total), 0), 2) AS confirmation_rate\nFROM mv_confirmation_rate_daily m\nJOIN events e ON e.id = m.event_id\nWHERE m.day >= current_date - interval '6 days'\n[[AND m.event_id = {{event_id}}]]\n[[AND e.organizer_id = {{organizer_id}}]]\nGROUP BY m.day\nORDER BY m.day;`,
          'template-tags': {
            event_id: eventTemplate,
            organizer_id: organizerTemplate,
          },
        },
      },
    }),
    upsertCard(organizerCollection.id, {
      name: 'Escaneos por hora (hoy)',
      display: 'bar',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  date_trunc('hour', s.ts) AS hour,\n  COUNT(*) FILTER (WHERE s.result = 'valid') AS scans_valid,\n  COUNT(*) FILTER (WHERE s.result <> 'valid') AS scans_other\nFROM scan_logs s\nJOIN guests g ON g.id = s.guest_id\nJOIN events e ON e.id = g.event_id\nWHERE date(s.ts) = current_date\n[[AND e.id = {{event_id}}]]\n[[AND e.organizer_id = {{organizer_id}}]]\nGROUP BY hour\nORDER BY hour;`,
          'template-tags': {
            event_id: eventTemplate,
            organizer_id: organizerTemplate,
          },
        },
      },
    }),
    upsertCard(organizerCollection.id, {
      name: 'Invitados (detalle)',
      display: 'table',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  g.id AS guest_id,\n  g.full_name,\n  g.email,\n  g.status,\n  g.confirmed_at,\n  g.check_in_at,\n  g.invite_link,\n  e.name AS event_name,\n  e.organizer_id\nFROM guests g\nJOIN events e ON e.id = g.event_id\nWHERE g.created_at >= current_date - interval '7 days'\n[[AND e.id = {{event_id}}]]\n[[AND e.organizer_id = {{organizer_id}}]]\nORDER BY g.created_at DESC\nLIMIT 500;`,
          'template-tags': {
            event_id: eventTemplate,
            organizer_id: organizerTemplate,
          },
        },
      },
      description: 'Tabla de invitados recientes con enlaces de invitación para auditoría rápida.',
    }),
  ]);

  const cardsByName = Object.fromEntries(organizerCards.map((card) => [card.name, card]));

  const eventParamId = crypto.randomUUID();
  const organizerParamId = crypto.randomUUID();
  await upsertDashboard(organizerCollection.id, {
    name: 'Organizer – Operación',
    description:
      'Dashboard operativo diario. Notas: el ratio de WhatsApp gratuito se calcula sobre sesiones activas (wa_sessions) y los enlaces directos vienen de invites.links.',
    parameters: buildDashboardParameters({ eventTagId: eventParamId, organizerTagId: organizerParamId }),
    dashcards: [
      {
        card_id: cardsByName['Confirmación hoy'].id,
        row: 0,
        col: 0,
        sizeX: 8,
        sizeY: 4,
        parameter_mappings: [
          mapping(eventParamId, 'event_id', cardsByName['Confirmación hoy'].id),
          mapping(organizerParamId, 'organizer_id', cardsByName['Confirmación hoy'].id),
        ],
      },
      {
        card_id: cardsByName['Show-up hoy'].id,
        row: 0,
        col: 8,
        sizeX: 8,
        sizeY: 4,
        parameter_mappings: [
          mapping(eventParamId, 'event_id', cardsByName['Show-up hoy'].id),
          mapping(organizerParamId, 'organizer_id', cardsByName['Show-up hoy'].id),
        ],
      },
      {
        card_id: cardsByName['Ratio WA gratuito 24h'].id,
        row: 0,
        col: 16,
        sizeX: 8,
        sizeY: 4,
        parameter_mappings: [
          mapping(eventParamId, 'event_id', cardsByName['Ratio WA gratuito 24h'].id),
          mapping(organizerParamId, 'organizer_id', cardsByName['Ratio WA gratuito 24h'].id),
        ],
      },
      {
        card_id: cardsByName['Confirmación últimos 7 días'].id,
        row: 4,
        col: 0,
        sizeX: 12,
        sizeY: 5,
        parameter_mappings: [
          mapping(eventParamId, 'event_id', cardsByName['Confirmación últimos 7 días'].id),
          mapping(organizerParamId, 'organizer_id', cardsByName['Confirmación últimos 7 días'].id),
        ],
      },
      {
        card_id: cardsByName['Escaneos por hora (hoy)'].id,
        row: 4,
        col: 12,
        sizeX: 12,
        sizeY: 5,
        parameter_mappings: [
          mapping(eventParamId, 'event_id', cardsByName['Escaneos por hora (hoy)'].id),
          mapping(organizerParamId, 'organizer_id', cardsByName['Escaneos por hora (hoy)'].id),
        ],
      },
      {
        card_id: cardsByName['Invitados (detalle)'].id,
        row: 9,
        col: 0,
        sizeX: 24,
        sizeY: 8,
        parameter_mappings: [
          mapping(eventParamId, 'event_id', cardsByName['Invitados (detalle)'].id),
          mapping(organizerParamId, 'organizer_id', cardsByName['Invitados (detalle)'].id),
        ],
      },
    ],
  });

  const directorCards = await Promise.all([
    upsertCard(directorCollection.id, {
      name: 'Mix de tipos de evento',
      display: 'pie',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  e.type,\n  COUNT(DISTINCT e.id) AS events_count,\n  COUNT(g.id) AS guests_count\nFROM events e\nLEFT JOIN guests g ON g.event_id = e.id\nWHERE e.created_at >= now() - interval '90 days'\n[[AND e.id = {{event_id}}]]\n[[AND e.organizer_id = {{organizer_id}}]]\nGROUP BY e.type\nORDER BY events_count DESC;`,
          'template-tags': {
            event_id: eventTemplate,
            organizer_id: organizerTemplate,
          },
        },
      },
      description: 'Distribución de eventos standard vs premium con volumen de invitados.',
    }),
    upsertCard(directorCollection.id, {
      name: 'Organizadores activos (90d)',
      display: 'scalar',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  COUNT(DISTINCT e.organizer_id) AS active_organizers\nFROM events e\nWHERE e.created_at >= now() - interval '90 days'\n[[AND e.id = {{event_id}}]]\n[[AND e.organizer_id = {{organizer_id}}]];`,
          'template-tags': {
            event_id: eventTemplate,
            organizer_id: organizerTemplate,
          },
        },
      },
      visualization_settings: {
        'card.title': 'Organizadores activos (90 días)',
        'scalar.field': 'active_organizers',
      },
    }),
    upsertCard(directorCollection.id, {
      name: 'Deuda abierta',
      display: 'scalar',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  COALESCE(SUM(d.open_debt), 0) AS open_debt\nFROM mv_organizer_debt d\n[[WHERE d.organizer_id = {{organizer_id}}]];`,
          'template-tags': {
            organizer_id: {
              ...organizerTemplate,
              dimension: ['field', ['field-id', debtOrganizerFieldId]],
            },
          },
        },
      },
      visualization_settings: {
        'card.title': 'Deuda abierta (ARS)',
        'scalar.field': 'open_debt',
      },
    }),
    upsertCard(directorCollection.id, {
      name: 'Top organizadores por tickets',
      display: 'table',
      dataset_query: {
        database: Number(DATABASE_ID),
        type: 'native',
        native: {
          query: `SELECT\n  o.name AS organizer_name,\n  d.prepaid_tickets,\n  d.loan_tickets,\n  (COALESCE(d.prepaid_tickets, 0) + COALESCE(d.loan_tickets, 0)) AS total_tickets,\n  d.open_debt,\n  d.last_payment_at\nFROM mv_organizer_debt d\nJOIN organizers o ON o.id = d.organizer_id\n[[WHERE d.organizer_id = {{organizer_id}}]]\nORDER BY total_tickets DESC\nLIMIT 20;`,
          'template-tags': {
            organizer_id: {
              ...organizerTemplate,
              dimension: ['field', ['field-id', debtOrganizerFieldId]],
            },
          },
        },
      },
      description: 'Ranking por tickets equivalentes pendientes (prepago + préstamo).',
    }),
  ]);

  const directorCardsMap = Object.fromEntries(directorCards.map((card) => [card.name, card]));
  const directorEventParamId = crypto.randomUUID();
  const directorOrganizerParamId = crypto.randomUUID();

  await upsertDashboard(directorCollection.id, {
    name: 'Director – Ejecutivo',
    description:
      'Panel ejecutivo. Notas: la heurística WA gratuito usa delivery_logs.is_free y las equivalencias de tickets se documentan en ticket_ledger.equiv_json.',
    parameters: buildDashboardParameters({
      eventTagId: directorEventParamId,
      organizerTagId: directorOrganizerParamId,
    }),
    dashcards: [
      {
        card_id: directorCardsMap['Mix de tipos de evento'].id,
        row: 0,
        col: 0,
        sizeX: 12,
        sizeY: 5,
        parameter_mappings: [
          mapping(directorEventParamId, 'event_id', directorCardsMap['Mix de tipos de evento'].id),
          mapping(
            directorOrganizerParamId,
            'organizer_id',
            directorCardsMap['Mix de tipos de evento'].id
          ),
        ],
      },
      {
        card_id: directorCardsMap['Organizadores activos (90d)'].id,
        row: 0,
        col: 12,
        sizeX: 12,
        sizeY: 5,
        parameter_mappings: [
          mapping(directorEventParamId, 'event_id', directorCardsMap['Organizadores activos (90d)'].id),
          mapping(
            directorOrganizerParamId,
            'organizer_id',
            directorCardsMap['Organizadores activos (90d)'].id
          ),
        ],
      },
      {
        card_id: directorCardsMap['Deuda abierta'].id,
        row: 5,
        col: 0,
        sizeX: 12,
        sizeY: 5,
        parameter_mappings: [
          mapping(directorOrganizerParamId, 'organizer_id', directorCardsMap['Deuda abierta'].id),
        ],
      },
      {
        card_id: directorCardsMap['Top organizadores por tickets'].id,
        row: 5,
        col: 12,
        sizeX: 12,
        sizeY: 8,
        parameter_mappings: [
          mapping(
            directorOrganizerParamId,
            'organizer_id',
            directorCardsMap['Top organizadores por tickets'].id
          ),
        ],
      },
    ],
  });

  await assignCollectionPermissions(parentCollection.id);
  await assignCollectionPermissions(organizerCollection.id);
  await assignCollectionPermissions(directorCollection.id);

  console.log('Metabase dashboards are up to date.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
