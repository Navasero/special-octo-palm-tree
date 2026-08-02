/**
 * Start the FHIR API over a seeded encounter.
 *
 * Run: npm run serve    (PORT=8080 by default)
 */

import { createFhirServer } from './api/server.ts';
import { DEMO_TENANT, runEncounterScenario } from './scenario.ts';

const scenario = runEncounterScenario();
const port = Number(process.env.PORT ?? 8080);

const server = createFhirServer({ tenants: new Map([[DEMO_TENANT, scenario.log]]) });

server.listen(port, () => {
  const base = `http://localhost:${port}/fhir/${DEMO_TENANT}`;
  console.log(`VITA FHIR API listening on ${base}`);
  console.log('');
  console.log('Every request to PHI needs an actor and a stated purpose:');
  console.log('  -H "X-Actor-Id: prac-0007" -H "X-Purpose: treatment"');
  console.log('');
  console.log('Try:');
  console.log(`  curl ${base}/metadata`);
  console.log(`  curl -H "X-Actor-Id: prac-0007" -H "X-Purpose: treatment" \\`);
  console.log(`       ${base}/Condition?patient=pat-0001`);
  console.log(`  curl -H "X-Actor-Id: prac-0007" -H "X-Purpose: treatment" \\`);
  console.log(`       ${base}/Patient/pat-0001/\\$everything`);
  console.log(`  curl -H "X-Actor-Id: ops-0001" -H "X-Purpose: tenant-export" \\`);
  console.log(`       "${base}/\\$export?_outputFormat=manifest"`);
  console.log(`  curl -H "X-Actor-Id: audit-0001" -H "X-Purpose: audit" \\`);
  console.log(`       ${base}/AuditEvent`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
