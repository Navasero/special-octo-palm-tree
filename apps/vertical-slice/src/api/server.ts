/**
 * FHIR R4 REST API over the event-sourced core.
 *
 * Built on node:http with no framework — the routing surface is small enough
 * that a dependency would cost more (supply chain, upgrade treadmill,
 * air-gapped install) than it saves.
 *
 * Two rules this server enforces that a generic FHIR server would not:
 *  - No anonymous access to PHI. Identity and purpose are required on every
 *    request, and every read is written to the audit log before the response
 *    is sent.
 *  - Writes are attributed to a human. The API cannot be used to inject
 *    AI-authored content that bypasses the draft/review contract; drafts are
 *    created by the ambient pipeline, not by callers claiming to be a model.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { EventLog } from '../core/eventLog.ts';
import { project } from '../core/projection.ts';
import { toFhirProvenance } from '../core/provenance.ts';
import { patientEverything, subjectOf, tenantExport } from './export.ts';
import { capabilityStatement, SUPPORTED_SEARCH, WRITABLE } from './capability.ts';
import type {
  AnyResource,
  AuditEvent,
  Bundle,
  ClinicalResource,
  OperationOutcome,
  ResourceType,
} from '../fhir/types.ts';

const FHIR_JSON = 'application/fhir+json';

export type Requester = {
  actorId: string;
  purpose: string;
  breakTheGlass?: { justification: string };
};

function outcome(severity: 'error' | 'fatal', code: string, diagnostics: string): OperationOutcome {
  return { resourceType: 'OperationOutcome', issue: [{ severity, code, diagnostics }] };
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Identity is asserted by header in this slice. The point being demonstrated
 * is not the auth mechanism but that no code path reaches PHI without an
 * actor and a stated purpose to write into the audit log.
 */
function requesterFrom(req: IncomingMessage): Requester {
  const actorId = req.headers['x-actor-id'];
  const purpose = req.headers['x-purpose'];
  if (typeof actorId !== 'string' || actorId.trim() === '') {
    throw new HttpError(401, 'login', 'X-Actor-Id is required; anonymous access to PHI is refused');
  }
  if (typeof purpose !== 'string' || purpose.trim() === '') {
    throw new HttpError(
      403,
      'forbidden',
      'X-Purpose is required; every access to PHI must state why it happened',
    );
  }
  const justification = req.headers['x-break-the-glass'];
  return {
    actorId,
    purpose,
    breakTheGlass:
      typeof justification === 'string' && justification.trim() !== ''
        ? { justification }
        : undefined,
  };
}

function bundleOf(id: string, resources: AnyResource[]): Bundle {
  return {
    resourceType: 'Bundle',
    id,
    type: 'searchset',
    timestamp: new Date().toISOString(),
    total: resources.length,
    entry: resources.map((resource) => ({
      fullUrl: `urn:uuid:${resource.resourceType}-${resource.id}`,
      resource,
      search: { mode: 'match' },
    })),
  };
}

function referenceId(value: string | null): string | null {
  if (!value) return null;
  return value.includes('/') ? (value.split('/')[1] ?? null) : value;
}

/** The read audit, projected into FHIR so auditors use one client, not two. */
function auditEvents(log: EventLog, patientId: string | null): AuditEvent[] {
  return log
    .reads()
    .filter((read) => patientId === null || read.patientId === patientId)
    .map((read, index) => ({
      resourceType: 'AuditEvent',
      id: `audit-${index}`,
      type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest' },
      action: 'R',
      recorded: read.at,
      outcome: '0',
      agent: [
        {
          who: { reference: `Practitioner/${read.actorId}` },
          requestor: true,
          purposeOfUse: [{ coding: [{ system: 'http://vita-emr.org/purpose', code: read.purpose }] }],
        },
      ],
      entity: [
        {
          what: { reference: `Patient/${read.patientId}` },
          detail: [
            { type: 'resourceTypes', valueString: read.resourceTypes.join(',') },
            ...(read.breakTheGlass
              ? [{ type: 'breakTheGlass', valueString: read.breakTheGlass.justification }]
              : []),
          ],
        },
      ],
    }));
}

export type ServerOptions = {
  /** One log per tenant — schema-per-tenant isolation carried to the edge. */
  tenants: Map<string, EventLog>;
  basePath?: string;
};

export function createFhirServer(options: ServerOptions): Server {
  const basePath = options.basePath ?? '/fhir';

  return createServer((req, res) => {
    try {
      handle(req, res, options, basePath);
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, outcome('error', error.code, error.message));
      } else {
        send(res, 500, outcome('fatal', 'exception', (error as Error).message));
      }
    }
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': FHIR_JSON,
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendNdjson(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    'Content-Type': 'application/fhir+ndjson',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  basePath: string,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (!path.startsWith(`${basePath}/`)) {
    throw new HttpError(404, 'not-found', `no route for ${path}; FHIR base is ${basePath}/{tenant}`);
  }

  const segments = path.slice(basePath.length + 1).split('/').filter(Boolean);
  const tenantId = segments[0];
  const log = tenantId ? options.tenants.get(tenantId) : undefined;
  if (!log) {
    // Deliberately the same response for "no such tenant" and "not yours":
    // tenant existence is itself information.
    throw new HttpError(404, 'not-found', `unknown tenant: ${tenantId ?? '(none)'}`);
  }

  const rest = segments.slice(1);

  // GET {base}/{tenant}/metadata — no PHI, so no identity required.
  if (rest[0] === 'metadata' && req.method === 'GET') {
    send(res, 200, capabilityStatement(`${basePath}/${tenantId}`));
    return;
  }

  const requester = requesterFrom(req);

  // GET {base}/{tenant}/$export
  if (rest[0] === '$export' && req.method === 'GET') {
    const manifest = tenantExport(log, requester);
    if (url.searchParams.get('_outputFormat') === 'manifest') {
      send(res, 200, { ...manifest, output: manifest.output.map(({ ndjson, ...f }) => f) });
      return;
    }
    sendNdjson(res, manifest.output.map((file) => file.ndjson).join('\n'));
    return;
  }

  const [type, id, operation] = rest;
  if (!type) throw new HttpError(404, 'not-found', 'no resource type in path');

  // GET {base}/{tenant}/Patient/{id}/$everything
  if (operation === '$everything' && req.method === 'GET') {
    if (type !== 'Patient') {
      throw new HttpError(400, 'not-supported', '$everything is defined on Patient only');
    }
    const exists = [...project(log).values()].some((e) => e.resource.id === id);
    if (!exists) throw new HttpError(404, 'not-found', `no Patient/${id}`);
    send(res, 200, patientEverything(log, id!, requester));
    return;
  }
  if (operation) throw new HttpError(404, 'not-found', `unsupported operation ${operation}`);

  if (req.method === 'POST') {
    createResource(req, res, log, type, requester);
    return;
  }
  if (req.method !== 'GET') {
    throw new HttpError(405, 'not-supported', `${req.method} is not supported`);
  }

  if (type === 'AuditEvent') {
    send(res, 200, bundleOf('audit', auditEvents(log, referenceId(url.searchParams.get('patient')))));
    return;
  }

  if (type === 'Provenance') {
    const target = url.searchParams.get('target');
    if (!target) throw new HttpError(400, 'required', 'Provenance search requires target=Type/id');
    const provenance = toFhirProvenance(log, referenceId(target)!);
    send(res, 200, bundleOf('provenance', provenance ? [provenance] : []));
    return;
  }

  if (!(type in SUPPORTED_SEARCH)) {
    throw new HttpError(404, 'not-supported', `unknown resource type ${type}`);
  }

  const chart = [...project(log).values()].map((entry) => entry.resource);

  // Instance read.
  if (id) {
    const resource = chart.find((r) => r.resourceType === type && r.id === id);
    if (!resource) throw new HttpError(404, 'not-found', `no ${type}/${id}`);
    audit(log, resource, requester);
    send(res, 200, resource);
    return;
  }

  // Type-level search.
  const unknown = [...url.searchParams.keys()].filter(
    (key) => !SUPPORTED_SEARCH[type].includes(key) && !key.startsWith('_count'),
  );
  if (unknown.length > 0) {
    // Silently ignoring an unrecognised filter returns more data than asked
    // for, which for PHI is the wrong failure direction.
    throw new HttpError(
      400,
      'not-supported',
      `unsupported search parameter(s) for ${type}: ${unknown.join(', ')}. ` +
        `supported: ${SUPPORTED_SEARCH[type].join(', ')}`,
    );
  }

  const patientFilter =
    referenceId(url.searchParams.get('patient')) ?? referenceId(url.searchParams.get('subject'));
  const encounterFilter = referenceId(url.searchParams.get('encounter'));
  const statusFilter = url.searchParams.get('status');
  const idFilter = url.searchParams.get('_id');

  const matches = chart.filter((resource) => {
    if (resource.resourceType !== type) return false;
    if (idFilter && resource.id !== idFilter) return false;
    if (patientFilter && subjectOf(resource) !== patientFilter) return false;
    if (encounterFilter) {
      const encounter = 'encounter' in resource ? resource.encounter?.reference : undefined;
      if (referenceId(encounter ?? null) !== encounterFilter) return false;
    }
    if (statusFilter) {
      const status =
        'docStatus' in resource
          ? resource.docStatus
          : 'status' in resource
            ? resource.status
            : undefined;
      if (status !== statusFilter) return false;
    }
    return true;
  });

  for (const resource of matches) audit(log, resource, requester);
  send(res, 200, bundleOf(`search-${type}`, matches));
}

function audit(log: EventLog, resource: ClinicalResource, requester: Requester): void {
  const patientId = subjectOf(resource);
  if (!patientId) return;
  log.recordRead({
    actorId: requester.actorId,
    patientId,
    purpose: requester.purpose,
    breakTheGlass: requester.breakTheGlass,
    resourceTypes: [resource.resourceType],
  });
}

function createResource(
  req: IncomingMessage,
  res: ServerResponse,
  log: EventLog,
  type: string,
  requester: Requester,
): void {
  if (!WRITABLE.includes(type)) {
    throw new HttpError(405, 'not-supported', `${type} is not writable over the API`);
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on('end', () => {
    try {
      const resource = JSON.parse(body) as ClinicalResource;
      if (resource.resourceType !== type) {
        throw new HttpError(
          400,
          'invalid',
          `body resourceType ${resource.resourceType} does not match ${type}`,
        );
      }
      if (!resource.id) throw new HttpError(400, 'required', 'resource.id is required');

      // Writes over the API are human-authored by definition. An AI draft has
      // to come through the ambient pipeline, which attaches provenance and
      // puts the result in front of a clinician; letting a caller assert
      // "an AI wrote this" would route around the review contract entirely.
      log.append({
        tenantId: log.tenantId,
        actor: {
          kind: 'human',
          id: requester.actorId,
          display: requester.actorId,
          role: 'api-client',
        },
        op: 'create',
        resourceType: type as ResourceType,
        resourceId: resource.id,
        resource,
      });
      send(res, 201, resource);
    } catch (error) {
      if (error instanceof HttpError) {
        send(res, error.status, outcome('error', error.code, error.message));
      } else {
        send(res, 400, outcome('error', 'invalid', (error as Error).message));
      }
    }
  });
}
