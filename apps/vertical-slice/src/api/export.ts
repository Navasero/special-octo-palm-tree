/**
 * The acid test (Section 8): a competitor should be able to extract a
 * complete, usable copy of all data for one patient or the entire tenant, in
 * a documented open format, on demand, without our involvement.
 *
 * This file is that capability. It is deliberately not a favour we grant, an
 * export "feature", or a professional-services engagement — it is two
 * ordinary read endpoints over the same projection the clinical UI uses,
 * emitting standard FHIR. Nothing here can be revoked to trap a customer,
 * because there is nothing here to revoke.
 *
 * Both operations are themselves audited PHI reads. Bulk export is the single
 * highest-value target for an insider (docs/vita-emr/07-threat-model.md), so
 * "we let you take your data" and "we record that you took it" have to be
 * true at the same time.
 */

import type { EventLog } from '../core/eventLog.ts';
import { project } from '../core/projection.ts';
import { toFhirProvenance } from '../core/provenance.ts';
import type {
  AnyResource,
  Bundle,
  BundleEntry,
  ClinicalResource,
  Provenance,
} from '../fhir/types.ts';

export type ExportAccess = {
  actorId: string;
  purpose: string;
  breakTheGlass?: { justification: string };
};

/** Which patient a resource belongs to, or null for tenant-level resources. */
export function subjectOf(resource: ClinicalResource): string | null {
  if (resource.resourceType === 'Patient') return resource.id;
  if (resource.resourceType === 'AllergyIntolerance' || resource.resourceType === 'Claim') {
    return resource.patient.reference.split('/')[1] ?? null;
  }
  if ('subject' in resource) return resource.subject.reference.split('/')[1] ?? null;
  return null;
}

function entryFor(resource: AnyResource): BundleEntry {
  return {
    fullUrl: `urn:uuid:${resource.resourceType}-${resource.id}`,
    resource,
    search: { mode: 'match' },
  };
}

/**
 * `Patient/{id}/$everything` — the complete record for one patient.
 *
 * Includes the Provenance for every resource, not just the clinical content.
 * A record that arrives without its provenance is not a usable copy: the
 * receiving system cannot tell which entries a clinician attested to and
 * which an AI drafted, which is exactly the distinction that matters when
 * someone acts on it.
 */
export function patientEverything(
  log: EventLog,
  patientId: string,
  access: ExportAccess,
): Bundle {
  const resources = [...project(log).values()]
    .map((entry) => entry.resource)
    .filter((resource) => subjectOf(resource) === patientId);

  const provenance = resources
    .map((resource) => toFhirProvenance(log, resource.id))
    .filter((p): p is Provenance => p !== null);

  log.recordRead({
    actorId: access.actorId,
    patientId,
    purpose: access.purpose,
    breakTheGlass: access.breakTheGlass,
    resourceTypes: [...new Set(resources.map((r) => r.resourceType))],
  });

  const entries = [...resources, ...provenance].map(entryFor);
  return {
    resourceType: 'Bundle',
    id: `everything-${patientId}`,
    type: 'searchset',
    timestamp: new Date().toISOString(),
    total: entries.length,
    entry: entries,
  };
}

export type ExportFile = {
  type: string;
  count: number;
  /** Newline-delimited JSON, one resource per line — the Bulk FHIR format. */
  ndjson: string;
};

export type ExportManifest = {
  transactionTime: string;
  request: string;
  requiresAccessToken: boolean;
  output: ExportFile[];
  error: never[];
};

/**
 * Tenant-wide `$export` in Bulk FHIR NDJSON, grouped by resource type.
 *
 * Synchronous here because the slice holds one encounter in memory. The real
 * operation is the asynchronous kick-off/poll pattern; the manifest shape
 * returned is already the one that pattern delivers, so a client written
 * against this does not need rewriting later.
 */
export function tenantExport(log: EventLog, access: ExportAccess): ExportManifest {
  const byType = new Map<string, AnyResource[]>();

  for (const entry of project(log).values()) {
    const resource = entry.resource;
    byType.set(resource.resourceType, [...(byType.get(resource.resourceType) ?? []), resource]);

    const provenance = toFhirProvenance(log, resource.id);
    if (provenance) {
      byType.set('Provenance', [...(byType.get('Provenance') ?? []), provenance]);
    }
  }

  // One audit entry per patient in the export, not one for the whole run:
  // "someone exported everything" is not an adequate record of whose data
  // left the building.
  const patients = new Set(
    [...project(log).values()]
      .map((entry) => subjectOf(entry.resource))
      .filter((id): id is string => id !== null),
  );
  for (const patientId of patients) {
    log.recordRead({
      actorId: access.actorId,
      patientId,
      purpose: access.purpose,
      breakTheGlass: access.breakTheGlass,
      resourceTypes: [...byType.keys()].filter((t) => t !== 'Provenance') as never,
    });
  }

  return {
    transactionTime: new Date().toISOString(),
    request: '$export',
    requiresAccessToken: true,
    output: [...byType.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([type, resources]) => ({
        type,
        count: resources.length,
        ndjson: resources.map((resource) => JSON.stringify(resource)).join('\n'),
      })),
    error: [],
  };
}

/** Manifest without the payload, for listing what an export would contain. */
export function tenantExportManifest(
  log: EventLog,
  access: ExportAccess,
): Omit<ExportManifest, 'output'> & { output: { type: string; count: number }[] } {
  const full = tenantExport(log, access);
  return {
    ...full,
    output: full.output.map(({ type, count }) => ({ type, count })),
  };
}
