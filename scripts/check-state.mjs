import Database from 'better-sqlite3';

const db = new Database(process.env.DB_PATH);

// resolve-architecture-contract node run
const nr = db.prepare(`
  SELECT id, node_id, status, output_bindings, acceptance_receipt, error_message
    FROM factory_node_runs
   WHERE node_id = 'resolve-architecture-contract'
   ORDER BY id DESC LIMIT 1
`).get();

if (nr) {
  console.log('=== resolve-architecture-contract ===');
  console.log('node_run #' + nr.id, nr.status);
  console.log('acceptance_receipt:', nr.acceptance_receipt ? 'present' : 'NULL');
  const ob = JSON.parse(nr.output_bindings || '{}');
  console.log('event:', ob.event);
  console.log('gap:', ob.gap);
  console.log('baselineDriftArtifactIds:', JSON.stringify(ob.baselineDriftArtifactIds));
  console.log('srsArtifactId:', ob.srsArtifactId);
  if (ob.gateVerdict) {
    console.log('gateVerdict:', ob.gateVerdict);
    console.log('gateDecisionKey:', ob.gateDecisionKey);
  }
  if (nr.error_message) console.log('error:', nr.error_message);
}

// Check ALL node runs for this process run
const allRuns = db.prepare(`
  SELECT id, node_id, node_kind, status
    FROM factory_node_runs
   WHERE process_run_id = 2
   ORDER BY id
`).all();
console.log('\n=== All Formalization node runs ===');
for (const r of allRuns) {
  console.log('  #' + r.id, r.node_id, r.node_kind, r.status);
}

db.close();
