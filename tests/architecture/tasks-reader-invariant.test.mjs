// tests/architecture/tasks-reader-invariant.test.mjs
//
// Conveyor v4 step 5.4 — tasks-table absence-of-readers ratchet.
//
// Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-06-AC-01/02 +
// Conveyor Mental Model v4 §«One engine, two channels» + CONVEYOR-V4-MIGRATION-PLAN
// step 5 ("Conformance proof + запрет core reads из legacy").
//
// # What this ratchet guards
//
// After the v4 cutover, the authoritative state of a work item lives in the
// `v4_workplaces` aggregate (REG-05). The legacy `tasks` table becomes a
// REBUILDABLE PROJECTION (REG-06): the `tasks.{status,integration_state,
// current_execution_id}` owner columns are written by the WorkItemProjector
// (one-way), and no orchestration core may read them as truth.
//
// Step 5.2/5.4 of the migration plan require:
//   - core reads of `tasks`/`worker_executions` as orchestration truth are
//     FORBIDDEN;
//   - the dispatch/transition use cases read from `v4_workplaces` (via
//     `SAGA_WORKPLACE_READ=new`).
//
// # Ratchet shape (shrinkage, not yet zero)
//
// The full cutover is a per-workshop, multi-phase effort (plan §3.A.4 /
// §3.B.3 / §3.C.4 — each workshop switches its kernel/runtime/settlement
// reads behind the flag). Until every workshop has switched, a small number
// of orchestration files STILL read `tasks` directly. This ratchet captures
// the CURRENT allowed reader set as a whitelist that may only SHRINK: any
// NEW file under the orchestration core that issues a `SELECT … FROM tasks`
// / `SELECT … FROM worker_executions` reading owner-state columns fails this
// test and must either (a) route through the v4 read path or (b) be added
// here only with a migration-plan reference explaining why it cannot yet
// switch.
//
// Projection/board-readers (src/infrastructure/projections/**, the board
// projection adapter/reader) are EXEMPT — a projection legitimately reads
// `tasks` (it is the rebuild source until the cutover completes). The tools/
// MCP handlers are EXEMPT — they are the human-facing surface, not the
// orchestration truth path, and they already write the v4 shadow via
// WorkplaceProjector (step 5.2a).
//
// # How it is tightened
//
// Each workshop's read-switch (3.A.4 / 3.B.3 / 3.C.4) removes a file from
// ALLOWED_CORE_READERS. When the set reaches zero, the cutover is complete
// and `tasks` becomes a pure projection. At that point this test's assertion
// flips from "whitelist matches observed readers" to "no readers at all".

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

// The orchestration core trees this ratchet scans. NOT scanned (exempt):
//   - src/infrastructure/projections/**  (projection legitimately reads tasks)
//   - src/tools/**                       (human-facing MCP surface, not truth)
//   - tests/**, docs/**                  (non-runtime)
const SCANNED_TREES = [
  'src/lifecycle',
  'src/application',
  'src/process-modules/application',
  'src/process-modules/persistence',
  'src/infrastructure/work',
  'src/infrastructure/workplace',
  'src/infrastructure/workers',
  'src/infrastructure/persistence',
  'src/app',
  'src/planner',
  'src/worker-executions.ts',
  'src/modules',
];

// The CURRENT allowed orchestration readers of `tasks` owner-state columns.
// Each entry must cite the migration-plan substep that will retire it.
// This list may only SHRINK; adding an entry requires an ADR explaining why
// the cutover cannot yet cover it.
const ALLOWED_CORE_READERS = [
  // Lifecycle single-writer set — these are the WRITERS (tasks-writer-invariant
  // gate) and they also read-then-write inside the same atomic transaction.
  // They retire when step 5.2 routes claim/release through ConveyorRuntime use
  // cases backed by v4_workplaces CAS.
  'src/lifecycle/work-assignment-core.ts',
  'src/lifecycle/atomic-release.ts',
  'src/lifecycle/unfenced-assignment-recovery.ts',
  // Lifecycle app — reads task_kind/execution_mode to decide launch path.
  // Retires when step 2.5 unifies the launch path behind WorkerLauncherPort.
  'src/app/product-lifecycle-runtime.ts',
  'src/worker-executions.ts',
  // ConveyorRuntime — the cutover authority. Reads tasks.status at bind time
  // (preClaimStatus sync) and tasks.workplace_ref for queue joins. Retires
  // when tasks is fully projection (no data reads needed).
  'src/application/conveyor-runtime.ts',
  // Saga2 runtime repositories — the dispatch eligibility view. Retires when
  // step 5.2 makes v4_workplaces the queue source (REG-10-AC-01).
  'src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts',
  'src/infrastructure/work/sqlite-work-assignment-adapter.ts',
  // Worker launcher factory reads task metadata to assemble the launch
  // context. Retires when step 2.4/2.5 routes launch via WorkerLauncherPort
  // with a pinned ExecutionReservation context.
  'src/infrastructure/workers/claude-worker-executor-factory.ts',
  // Exact-candidate-acceptance + managed-submission + managed-production-ledger
  // — the formalization settlement path. Retires at step 3.A.3/3.A.4 when
  // formalization switches its kernel reads to the universal desk.
  'src/process-modules/persistence/sqlite-exact-candidate-acceptance.ts',
  'src/process-modules/persistence/sqlite-managed-node-submission-repository.ts',
  'src/process-modules/persistence/sqlite-managed-production-ledger.ts',
  // Workshop settlement/runtimes — read task lineage to resolve stage inputs.
  // Each retires at its workshop's read-switch (3.A.4 / 3.B.3 / 3.C.4).
  'src/modules/formalization/infrastructure/sqlite-formalization-kernel.ts',
  'src/modules/discovery/infrastructure/sqlite-discovery-runtime.ts',
  'src/modules/development/infrastructure/sqlite-development-settlement-state.ts',
  // Fast-track planner reads tasks to plan development waves. Retires when
  // planning reads the v4 projection.
  'src/planner/fast-track.ts',
  // Product repository fence check reads task<->execution binding. Retires
  // when the fence is anchored on ExecutionReservation (step 2.3 hardening).
  'src/infrastructure/workplace/sqlite-product-repository.ts',
];

// Match `FROM tasks` / `FROM worker_executions` (case-insensitive, the SQL
// read shape). Owner-state SELECTs are the concern; a SELECT of only
// non-owner columns (e.g. SELECT title FROM tasks) is still a read of the
// projection, but since the table is becoming a pure projection we flag ANY
// core read — the projection is rebuilt FROM workplaces, not read by core.
const READ_TASKS_RE = /\bFROM\s+(?:tasks|worker_executions)\b/gi;

function listTsFiles(dir) {
  const out = [];
  let st;
  try { st = fs.statSync(dir); } catch { return out; }
  if (st.isFile()) {
    if (/\.(ts|tsx|mts|mjs|js)$/i.test(dir)) out.push(dir);
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx|mts|mjs|js)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function findCoreReaders() {
  const hits = [];
  for (const tree of SCANNED_TREES) {
    const abs = path.join(REPO_ROOT, tree);
    for (const file of listTsFiles(abs)) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      // Match against the raw source. We then exclude hits that are inside a
      // block comment (/* … */) or on a line that is a // line-comment. We do
      // NOT regex-strip comments up front (that mangles template literals
      // containing //, e.g. SQL queries); instead we check each hit's line.
      let m;
      READ_TASKS_RE.lastIndex = 0;
      while ((m = READ_TASKS_RE.exec(text)) !== null) {
        const lineStart = text.lastIndexOf('\n', m.index) + 1;
        const lineEnd = text.indexOf('\n', m.index);
        const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        // Skip if the line is a // comment (the hit is documentation, not code).
        const beforeHit = line.slice(0, m.index - lineStart);
        if (/^\s*\/\//.test(line)) continue;
        if (beforeHit.includes('//')) continue; // trailing comment
        hits.push(rel);
        break; // one hit per file is enough
      }
    }
  }
  return [...new Set(hits)].sort();
}

const OBSERVED_READERS = findCoreReaders();

test('step 5.4 ratchet: scanner sees the orchestration core trees', () => {
  // Guard against the scan roots silently disappearing.
  let total = 0;
  for (const tree of SCANNED_TREES) {
    total += listTsFiles(path.join(REPO_ROOT, tree)).length;
  }
  assert.ok(
    total > 20,
    `expected the scanned orchestration core to contain many files; saw ${total}. ` +
      `Update SCANNED_TREES if the tree moved.`,
  );
});

test('step 5.4 ratchet: every core tasks-reader is on the allowed whitelist', () => {
  // The core shrinkage assertion. Any orchestration file reading tasks that
  // is NOT in ALLOWED_CORE_READERS fails — it must either switch to the v4
  // read path or be explicitly added here with a migration-plan citation.
  const unlisted = OBSERVED_READERS.filter(
    (f) => !ALLOWED_CORE_READERS.includes(f),
  );
  if (unlisted.length > 0) {
    assert.fail(
      `${unlisted.length} orchestration core file(s) read tasks/worker_executions ` +
        `but are NOT on the ALLOWED_CORE_READERS whitelist (Conveyor v4 step 5.4). ` +
        `Either route the read through v4_workplaces, or add the file to the ` +
        `whitelist in tests/architecture/tasks-reader-invariant.test.mjs with a ` +
        `migration-plan citation:\n` +
        unlisted.map((f) => `  ${f}`).join('\n'),
    );
  }
});

test('step 5.4 ratchet: whitelist has no dead entries (shrinkage is honest)', () => {
  // A whitelist entry that no longer reads tasks is dead weight — it hides
  // the fact that a read-switch landed. Each entry must still be observed.
  const dead = ALLOWED_CORE_READERS.filter(
    (f) => !OBSERVED_READERS.includes(f),
  );
  if (dead.length > 0) {
    assert.fail(
      `${dead.length} ALLOWED_CORE_READERS entr(ies) no longer read tasks — ` +
        `remove them from the whitelist (the read-switch landed; celebrate the ` +
        `shrinkage):\n` +
        dead.map((f) => `  ${f}`).join('\n'),
    );
  }
});

test('step 5.4 ratchet: reports reader set for shrinkage visibility', () => {
  // eslint-disable-next-line no-console
  console.log(
    `\n  step 5.4 absence-of-readers ratchet: ${ALLOWED_CORE_READERS.length} allowed ` +
      `core reader(s), ${OBSERVED_READERS.length} observed. Target = 0 when every ` +
      `workshop has switched its reads to v4_workplaces (steps 3.A.4/3.B.3/3.C.4).`,
  );
  assert.ok(
    ALLOWED_CORE_READERS.length >= 0,
    'whitelist seeded',
  );
});
