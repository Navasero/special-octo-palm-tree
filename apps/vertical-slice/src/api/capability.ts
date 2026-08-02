/**
 * The server's own description of what it can do (`GET /metadata`).
 *
 * Kept in one place and served live rather than written into documentation
 * that drifts: if a capability is listed here it is routed in server.ts, and
 * the test suite asserts the two agree. A CapabilityStatement that overstates
 * the server is worse than none, because integrators build against it.
 */

import type { CapabilityStatement } from '../fhir/types.ts';

export const SOFTWARE = { name: 'VITA EMR (vertical slice)', version: '0.1.0' };

/** Search parameters the server genuinely implements, per resource type. */
export const SUPPORTED_SEARCH: Record<string, string[]> = {
  Patient: ['_id', 'identifier'],
  Encounter: ['_id', 'patient', 'subject', 'status'],
  Condition: ['_id', 'patient', 'subject', 'encounter'],
  Observation: ['_id', 'patient', 'subject', 'encounter', 'status'],
  MedicationRequest: ['_id', 'patient', 'subject', 'encounter', 'status'],
  AllergyIntolerance: ['_id', 'patient'],
  DocumentReference: ['_id', 'patient', 'subject', 'status'],
  Claim: ['_id', 'patient', 'status'],
  Provenance: ['target'],
  AuditEvent: ['patient'],
};

/** Resource types that accept writes over the API. */
export const WRITABLE: string[] = [
  'Patient',
  'Encounter',
  'Condition',
  'Observation',
  'MedicationRequest',
  'AllergyIntolerance',
];

export function capabilityStatement(baseUrl: string): CapabilityStatement {
  return {
    resourceType: 'CapabilityStatement',
    id: 'vita-slice',
    status: 'draft',
    date: '2026-03-02',
    publisher: 'VITA',
    kind: 'instance',
    software: SOFTWARE,
    implementation: {
      description: 'VITA vertical slice — event-sourced FHIR R4 server',
      url: baseUrl,
    },
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    rest: [
      {
        mode: 'server',
        documentation:
          'Every capability the clinical UI has is available here (doctrine #7). ' +
          'All reads are audited. Identity is asserted with X-Actor-Id and X-Purpose; ' +
          'emergency access requires X-Break-The-Glass with a justification.',
        security: {
          description:
            'Header-asserted identity in this slice. A real deployment uses SMART on FHIR ' +
            'with per-tenant keys; the audit and break-the-glass semantics are unchanged.',
        },
        resource: Object.entries(SUPPORTED_SEARCH).map(([type, params]) => ({
          type,
          interaction: [
            { code: 'read' },
            { code: 'search-type' },
            ...(WRITABLE.includes(type) ? [{ code: 'create' }] : []),
          ],
          searchParam: params.map((name) => ({
            name,
            type: name === '_id' ? 'token' : 'reference',
          })),
          ...(type === 'Patient'
            ? {
                operation: [
                  {
                    name: 'everything',
                    definition: 'http://hl7.org/fhir/OperationDefinition/Patient-everything',
                    documentation:
                      'Complete record for one patient including Provenance. No cost, no ' +
                      'negotiation, no vendor involvement (Section 8 acid test).',
                  },
                ],
              }
            : {}),
        })),
        operation: [
          {
            name: 'export',
            definition: 'http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export',
            documentation:
              'Tenant-wide Bulk FHIR export as NDJSON. Synchronous in this slice; the ' +
              'manifest shape matches the asynchronous kick-off/poll contract.',
          },
        ],
      },
    ],
  };
}
