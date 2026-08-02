/**
 * API tests against a real listening HTTP server.
 *
 * Weighted toward the two claims the API exists to make good on: PHI is never
 * reachable without an attributed, audited, purpose-stated request; and the
 * customer can take a complete copy of their data whenever they like.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createFhirServer } from '../src/api/server.ts';
import { capabilityStatement, SUPPORTED_SEARCH, WRITABLE } from '../src/api/capability.ts';
import { DEMO_TENANT, runEncounterScenario } from '../src/scenario.ts';
import { EventLog, deterministicClock } from '../src/core/eventLog.ts';
import type { Bundle, CapabilityStatement, OperationOutcome } from '../src/fhir/types.ts';

let server: Server;
let base: string;
let log: EventLog;

const AUTH = { 'X-Actor-Id': 'prac-0007', 'X-Purpose': 'treatment' };

async function call(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; json: any; text: string; contentType: string }> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* NDJSON and other non-JSON payloads are asserted via `text`. */
  }
  return {
    status: response.status,
    json,
    text,
    contentType: response.headers.get('content-type') ?? '',
  };
}

before(() => {
  const scenario = runEncounterScenario();
  log = scenario.log;
  const empty = new EventLog('tenant-empty', deterministicClock());
  server = createFhirServer({ tenants: new Map([[DEMO_TENANT, log], ['tenant-empty', empty]]) });
  return new Promise<void>((resolve) => {
    server.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fhir/${DEMO_TENANT}`;
      resolve();
    });
  });
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ── Access control and audit ────────────────────────────────────────────────

describe('access control', () => {
  test('PHI is refused without an actor', async () => {
    const { status, json } = await call('/Patient/pat-0001');
    assert.equal(status, 401);
    assert.equal((json as OperationOutcome).resourceType, 'OperationOutcome');
    assert.match(json.issue[0].diagnostics, /anonymous access to PHI is refused/);
  });

  test('PHI is refused without a stated purpose', async () => {
    const { status, json } = await call('/Patient/pat-0001', {
      headers: { 'X-Actor-Id': 'prac-0007' },
    });
    assert.equal(status, 403);
    assert.match(json.issue[0].diagnostics, /must state why/);
  });

  test('metadata needs no identity — it carries no PHI', async () => {
    const { status, json } = await call('/metadata');
    assert.equal(status, 200);
    assert.equal((json as CapabilityStatement).resourceType, 'CapabilityStatement');
  });

  test('an unknown tenant is indistinguishable from a forbidden one', async () => {
    const other = await fetch(`${base.replace(DEMO_TENANT, 'tenant-someone-else')}/Patient/pat-0001`, {
      headers: AUTH,
    });
    assert.equal(other.status, 404);
    // Same status and shape as a tenant that exists but holds no such patient,
    // so probing cannot enumerate tenants.
    const empty = await fetch(`${base.replace(DEMO_TENANT, 'tenant-empty')}/Patient/pat-0001`, {
      headers: AUTH,
    });
    assert.equal(empty.status, 404);
  });

  test('reads land in the audit log and are queryable as AuditEvent', async () => {
    const before = log.reads().length;
    await call('/Condition?patient=pat-0001', { headers: AUTH });
    assert.ok(log.reads().length > before, 'a search of PHI must be audited');

    const { status, json } = await call('/AuditEvent?patient=pat-0001', {
      headers: { 'X-Actor-Id': 'audit-0001', 'X-Purpose': 'audit' },
    });
    assert.equal(status, 200);
    const bundle = json as Bundle;
    assert.ok(bundle.total > 0);
    assert.equal(bundle.entry[0].resource.resourceType, 'AuditEvent');
  });

  test('break-the-glass justification is carried into the audit record', async () => {
    await call('/Patient/pat-0001', {
      headers: {
        'X-Actor-Id': 'prac-9999',
        'X-Purpose': 'emergency',
        'X-Break-The-Glass': 'unresponsive patient, no consent obtainable',
      },
    });
    const { json } = await call('/AuditEvent?patient=pat-0001', {
      headers: { 'X-Actor-Id': 'audit-0001', 'X-Purpose': 'audit' },
    });
    const glass = (json as Bundle).entry
      .map((e) => e.resource as any)
      .find((r) => r.entity[0].detail?.some((d: any) => d.type === 'breakTheGlass'));
    assert.ok(glass, 'break-the-glass access must be distinguishable in the audit log');
    assert.match(
      glass.entity[0].detail.find((d: any) => d.type === 'breakTheGlass').valueString,
      /unresponsive/,
    );
  });
});

// ── Read and search ─────────────────────────────────────────────────────────

describe('read and search', () => {
  test('reads an instance', async () => {
    const { status, json, contentType } = await call('/Patient/pat-0001', { headers: AUTH });
    assert.equal(status, 200);
    assert.match(contentType, /application\/fhir\+json/);
    assert.equal(json.resourceType, 'Patient');
    assert.equal(json.name[0].family, 'Bautista');
  });

  test('404s a missing instance', async () => {
    const { status, json } = await call('/Patient/pat-nope', { headers: AUTH });
    assert.equal(status, 404);
    assert.equal(json.resourceType, 'OperationOutcome');
  });

  test('searches by patient', async () => {
    const { json } = await call('/Condition?patient=pat-0001', { headers: AUTH });
    const bundle = json as Bundle;
    assert.equal(bundle.type, 'searchset');
    assert.ok(bundle.total >= 4);
    assert.ok(bundle.entry.every((e) => e.resource.resourceType === 'Condition'));
  });

  test('a rejected draft is absent from search results', async () => {
    const { json } = await call('/Condition?patient=pat-0001', { headers: AUTH });
    const ids = (json as Bundle).entry.map((e) => e.resource.id);
    assert.ok(
      !ids.some((id) => id.includes('fever')),
      'the rejected fever must not be readable as chart content',
    );
  });

  test('searches by status', async () => {
    const { json } = await call('/MedicationRequest?patient=pat-0001&status=active', {
      headers: AUTH,
    });
    assert.equal((json as Bundle).total, 2);
  });

  test('an unsupported search parameter is rejected, not ignored', async () => {
    // Ignoring it would quietly return the unfiltered set — the wrong failure
    // direction for PHI.
    const { status, json } = await call('/Condition?patient=pat-0001&onset-date=2026', {
      headers: AUTH,
    });
    assert.equal(status, 400);
    assert.match(json.issue[0].diagnostics, /unsupported search parameter/);
  });

  test('provenance is retrievable for any resource', async () => {
    const { json } = await call('/Provenance?target=DocumentReference/note-0001', {
      headers: AUTH,
    });
    const bundle = json as Bundle;
    assert.equal(bundle.total, 1);
    assert.equal(bundle.entry[0].resource.resourceType, 'Provenance');
  });
});

// ── Writes ──────────────────────────────────────────────────────────────────

describe('writes', () => {
  test('creates a resource attributed to the caller', async () => {
    const body = JSON.stringify({
      resourceType: 'Observation',
      id: 'obs-api-001',
      status: 'final',
      category: [{ coding: [{ system: 'x', code: 'vital-signs' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
      subject: { reference: 'Patient/pat-0001' },
      encounter: { reference: 'Encounter/enc-0001' },
      effectiveDateTime: '2026-03-02T09:40:00.000Z',
      valueQuantity: { value: 78, unit: '/min' },
    });
    const { status } = await call('/Observation', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/fhir+json' },
      body,
    });
    assert.equal(status, 201);

    const written = log.forResource('obs-api-001').at(-1)!;
    assert.equal(written.actor.kind, 'human', 'API writes are human-authored by construction');
    assert.equal(written.actor.id, 'prac-0007');
  });

  test('a body that disagrees with the URL is rejected', async () => {
    const { status, json } = await call('/Condition', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify({ resourceType: 'Observation', id: 'x' }),
    });
    assert.equal(status, 400);
    assert.match(json.issue[0].diagnostics, /does not match/);
  });

  test('a claim cannot be conjured over the API', async () => {
    // Money-touching resources are not writable here; they come from the
    // billing path, which requires a signed note.
    const { status } = await call('/Claim', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/fhir+json' },
      body: JSON.stringify({ resourceType: 'Claim', id: 'claim-forged' }),
    });
    assert.equal(status, 405);
  });
});

// ── The acid test ───────────────────────────────────────────────────────────

describe('acid test: complete data export', () => {
  test('$everything returns the whole record including provenance', async () => {
    const { status, json } = await call('/Patient/pat-0001/$everything', { headers: AUTH });
    assert.equal(status, 200);
    const bundle = json as Bundle;
    const types = new Set(bundle.entry.map((e) => e.resource.resourceType));

    for (const expected of [
      'Patient',
      'Encounter',
      'Condition',
      'AllergyIntolerance',
      'MedicationRequest',
      'Observation',
      'DocumentReference',
      'Claim',
      'Provenance',
    ]) {
      assert.ok(types.has(expected as any), `$everything is missing ${expected}`);
    }
  });

  test('the exported note is the signed one, readable without our software', async () => {
    const { json } = await call('/Patient/pat-0001/$everything', { headers: AUTH });
    const note = (json as Bundle).entry
      .map((e) => e.resource as any)
      .find((r) => r.resourceType === 'DocumentReference');
    assert.equal(note.docStatus, 'final');
    const text = Buffer.from(note.content[0].attachment.data, 'base64').toString('utf8');
    assert.match(text, /Blood pressure 150\/95 mmHg/);
    assert.ok(!/Fever/.test(text), 'the rejected finding must not survive into the export');
  });

  test('$export returns Bulk FHIR NDJSON', async () => {
    const { status, text, contentType } = await call('/$export', {
      headers: { 'X-Actor-Id': 'ops-0001', 'X-Purpose': 'tenant-export' },
    });
    assert.equal(status, 200);
    assert.match(contentType, /application\/fhir\+ndjson/);

    const lines = text.split('\n').filter(Boolean);
    assert.ok(lines.length > 10);
    for (const line of lines) {
      // Every line must independently parse — that is the whole contract.
      assert.ok(JSON.parse(line).resourceType, 'each NDJSON line is a complete resource');
    }
  });

  test('$export manifest lists the files', async () => {
    const { json } = await call('/$export?_outputFormat=manifest', {
      headers: { 'X-Actor-Id': 'ops-0001', 'X-Purpose': 'tenant-export' },
    });
    assert.ok(json.output.length >= 8);
    assert.equal(json.requiresAccessToken, true);
    assert.ok(json.output.every((f: any) => typeof f.count === 'number' && !('ndjson' in f)));
  });

  test('bulk export is audited per patient, not once for the run', async () => {
    const before = log.reads().length;
    await call('/$export', {
      headers: { 'X-Actor-Id': 'ops-0002', 'X-Purpose': 'tenant-export' },
    });
    const added = log.reads().slice(before);
    assert.ok(added.length > 0);
    assert.ok(
      added.every((read) => read.patientId && read.actorId === 'ops-0002'),
      'each patient whose data left the building must be individually recorded',
    );
  });
});

// ── The CapabilityStatement must not lie ────────────────────────────────────

describe('capability statement', () => {
  test('every declared resource type is actually readable', async () => {
    const statement = capabilityStatement('/fhir/t');
    for (const declared of statement.rest[0].resource) {
      const { status } = await call(`/${declared.type}?_id=nothing-matches-this`, {
        headers: AUTH,
      });
      // Provenance requires target=, AuditEvent takes patient= — both are
      // declared with their own params, so a 400 is a correct answer here.
      assert.ok(
        status === 200 || status === 400,
        `${declared.type} is declared but returned ${status}`,
      );
    }
  });

  test('declared search parameters match what the server enforces', () => {
    const statement = capabilityStatement('/fhir/t');
    for (const declared of statement.rest[0].resource) {
      assert.deepEqual(
        declared.searchParam?.map((p) => p.name).sort(),
        [...SUPPORTED_SEARCH[declared.type]].sort(),
        `${declared.type} declares search params the server does not implement`,
      );
    }
  });

  test('create is declared only where writes are accepted', async () => {
    const statement = capabilityStatement('/fhir/t');
    for (const declared of statement.rest[0].resource) {
      const declaresCreate = declared.interaction.some((i) => i.code === 'create');
      assert.equal(
        declaresCreate,
        WRITABLE.includes(declared.type),
        `${declared.type}: declared create=${declaresCreate} but writable=${WRITABLE.includes(declared.type)}`,
      );
    }
  });
});
