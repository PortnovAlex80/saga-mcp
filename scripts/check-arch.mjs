import Database from 'better-sqlite3';

const db = new Database(process.env.DB_PATH);

const nr = db.prepare(`
  SELECT id, node_id, status, output_bindings, acceptance_receipt, error_message,
         production_envelope, completion
    FROM factory_node_runs
   WHERE node_id = 'resolve-architecture-contract'
   ORDER BY id DESC LIMIT 1
`).get();

if (nr) {
  console.log('=== resolve-architecture-contract #' + nr.id + ' ===');
  console.log('status:', nr.status);
  console.log('acceptance_receipt:', nr.acceptance_receipt ? 'present' : 'NULL');
  console.log('error:', nr.error_message);
  const ob = JSON.parse(nr.output_bindings || '{}');
  console.log('output_bindings keys:', Object.keys(ob));
  console.log('event:', ob.event);
  console.log('gap:', ob.gap);
  console.log('gateVerdict:', ob.gateVerdict);
  console.log('gateDecisionKey:', ob.gateDecisionKey);
  console.log('srsArtifactId:', ob.srsArtifactId);
  if (nr.production_envelope) {
    const pe = JSON.parse(nr.production_envelope);
    console.log('production_envelope keys:', Object.keys(pe));
    console.log('exactCandidateAcceptance present:', !!pe.exactCandidateAcceptance);
  }
  if (nr.completion) {
    console.log('completion:', nr.completion.slice(0, 300));
  }
}

// Also check settle node_run
const settle = db.prepare(`
  SELECT id, node_id, status, error_message
    FROM factory_node_runs
   WHERE node_id = 'settle-formalization' OR node_id LIKE '%settle%'
   ORDER BY id DESC LIMIT 1
`).get();
if (settle) {
  console.log('\n=== settle #' + settle.id + ' ===');
  console.log('status:', settle.status);
  console.log('error:', settle.error_message ? settle.error_message.slice(0, 400) : 'none');
}

// Check complete-failed
const cf = db.prepare(`
  SELECT id, node_id, status, error_message
    FROM factory_node_runs
   WHERE node_id = 'complete-failed'
   ORDER BY id DESC LIMIT 1
`).get();
if (cf) {
  console.log('\n=== complete-failed #' + cf.id + ' ===');
  console.log('status:', cf.status);
  console.log('error:', cf.error_message ? cf.error_message.slice(0, 400) : 'none');
}

db.close();
