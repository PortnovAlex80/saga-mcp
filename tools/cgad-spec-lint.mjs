#!/usr/bin/env node
// cgad-spec-lint v0.1 — read-only CGAD invariants auditor for a saga DB.
//
// Companion artifact to ADR-005 (saga-as-cgad-lite-evolution). Partially closes
// CGAD gap #6: provides the one external enforcement point the cgad SKILL v0.1
// "Limitations" section asks for. Per GUARDRAILS Sign 008, this script does NOT
// make saga "CGAD-compliant" — it audits three specific rules today and leaves
// the rest (gaps #1/#2/#3/#4/#5, plus the full forbidden-constructs catalog from
// CGAD §22) to future REQ-008..REQ-012 per the ADR-005 Roadmap.
//
// Read-only. Opens the saga DB in read-only mode. Mutates nothing.
// Exits non-zero if any rule reports a finding.

import sqlite3 from "node:sqlite";
import process from "node:process";

const LINTER_VERSION = "cgad-spec-lint/1.0.0";

// ---------- CLI ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { help: true };
  }
  let format = "text";
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") format = "json";
    else if (a === "--sarif") format = "sarif";
    else if (a === "--project-id") {
      const v = args[++i];
      if (!v) throw new Error("--project-id requires a value");
      positional.push({ opt: "projectId", val: Number(v) });
    } else if (a.startsWith("--")) {
      throw new Error(`unknown option: ${a}`);
    } else {
      positional.push({ opt: "dbPath", val: a });
    }
  }
  const dbPath = positional.find((p) => p.opt === "dbPath")?.val;
  const projectId = positional.find((p) => p.opt === "projectId")?.val;
  if (!dbPath) throw new Error("missing required positional: <db-path>");
  return { dbPath, projectId, format, help: false };
}

function usage() {
  return [
    "cgad-spec-lint v0.1 — read-only CGAD invariants auditor for a saga DB.",
    "",
    "Usage:",
    "  node cgad-spec-lint.mjs <db-path> [--project-id N] [--json | --sarif]",
    "",
    "Rules (CGAD gap → rule, see ADR-005 Roadmap):",
    "  CGAD-R1  deny-by-default (REQ-008 strengthened) — verification_evidence",
    "           outcome is now 4-valued: passed/failed/unknown/error. Only",
    "           'passed' admits a transition (CGAD P14). R1 surfaces evidence",
    "           rows whose outcome is failed/unknown/error, or whose",
    "           recorded_by is NULL (UNKNOWN under P13/P14), or whose provider",
    "           is NULL (CGAD §6 — every guard input needs a registered",
    "           provider). error-severity outcomes also flag the missing",
    "           Incident (CGAD P8).",
    "  CGAD-R2  P15 risk floor (REQ-009 strengthened):",
    "           R2a — tasks tagged critical/security with priority in {low,",
    "           medium} (legacy column betrays the tag).",
    "           R2b — tasks where final_risk is NULL while declared/derived/",
    "           policy are set, OR final_risk < max(declared, derived, policy).",
    "           CGAD P15: agent cannot self-lower final_risk below the derived",
    "           or policy floor. The max() computation in tasks.ts must hold.",
    "  CGAD-R3  GUARDRAILS Sign 006 — every accepted AC with at least one",
    "           'implements' trace MUST also have at least one 'verified_by' trace",
    "           to a task with passing verification_evidence. implements alone is",
    "           structural coverage, not satisfaction.",
    "  CGAD-R4  GUARDRAILS Sign 002 + CGAD §34 — a greenfield episode reaching",
    "           the development stage with ≥2 parallel git_change tasks sharing",
    "           a module MUST have a scaffold task (tag 'scaffold' or title",
    "           'SCAFFOLD:'). Without it, git's merge-conflict detector is the",
    "           only thing stopping parallel workers from racing on the same",
    "           files — exactly what CGAD §34 forbids.",
    "  CGAD-R5  CGAD §34 + REQ-010 — semantic collisions in task_conflict_keys.",
    "           Two ACTIVE tasks sharing a (key_type, key_value) pair collide",
    "           semantically. 2 colliding → warning; 3+ colliding OR ≥2 in",
    "           flight → error (scaffold MANDATORY). Without R5, the collision",
    "           is detected only when git merge fails.",
    "  CGAD-R6  CGAD §26 — agent self-sets state. Tasks with status != todo",
    "           whose updated_at > created_at+5s but ZERO activity_log entries.",
    "           Transitions must be recorded in the Workflow Ledger.",
    "  CGAD-R7  CGAD §29 — non-atomic episode transition. Episode reached a",
    "           non-discovery stage with no episode_stage entry in activity_log.",
    "  CGAD-R8  CGAD §32 — Frozen Contract edited in place. Accepted artifact",
    "           with drift_state='drifted'. Restore the file or supersede.",
    "  CGAD-R9  CGAD §39 / P7 — self-approval. verification_evidence recorded",
    "           by the SAME worker_id that built the dev task for the same AC.",
    "           Verifier must be different from Builder.",
    "  CGAD-R10 CGAD §42 — Work Package self-decomposition. Task's",
    "           generated_from_task_id points to itself or forms a 2-cycle.",
    "  CGAD-R11 CGAD §46 — hidden exception without owner/reason. needs-human",
    "           tagged task with no assigned_to AND no comments.",
    "  CGAD-R12 CGAD §43 — human approval as proof. verified_by trace pointing",
    "           to a task whose task_kind is NOT 'verification.ac'.",
    "",
    "Exit codes:",
    "  0  no findings (or only warnings)",
    "  1  one or more error-severity findings",
    "  2  usage error / DB error",
    "",
    "Per Sign 008: this lint is descriptive of saga's current partial CGAD",
    "compliance; passing it does NOT imply full CGAD compliance.",
  ].join("\n");
}

// ---------- Rule dispatch ----------

function openDb(dbPath) {
  try {
    return new sqlite3.DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    throw new Error(`failed to open DB read-only at ${dbPath}: ${e.message}`);
  }
}

// R1 — deny-by-default on verification_evidence (REQ-008 strengthened).
// After REQ-008 the outcome enum is {passed, failed, unknown, error}. CGAD P14
// says: only 'passed' admits a transition. R1 surfaces evidence rows that:
//   (a) have outcome 'failed' / 'unknown' / 'error' — non-passing evidence
//       must NOT silently satisfy a downstream gate. error also implies an
//       Incident should exist (P8) — we cannot check that from the DB alone,
//       but we flag it loudly so the human looks.
//   (b) have no recorded_by (no provenance → UNKNOWN under P13/P14).
//   (c) have no provider (REQ-008 introduced the column; backfill is gradual,
//       so today this is informational — warning severity, not error).
// project filter clause helper: tasks reach projects via epics.project_id.
function projectFilter(projectId, tableAlias) {
  if (projectId === undefined) return "";
  const a = tableAlias || "t";
  return `AND ${a}.epic_id IN (SELECT id FROM epics WHERE project_id = ${Number(projectId)})`;
}

function ruleR1(db, projectId) {
  const pj = projectFilter(projectId, "t");
  const findings = [];

  // R1a: non-passing outcome present anywhere — deny-by-default.
  const nonPassing = db.prepare(`
    SELECT ve.id, ve.task_id, ve.artifact_id, ve.outcome, ve.recorded_by, ve.created_at
    FROM verification_evidence ve
    JOIN tasks t ON t.id = ve.task_id
    WHERE ve.outcome IN ('failed','unknown','error') ${pj}
    ORDER BY ve.id`).all();
  for (const r of nonPassing) {
    const sev = r.outcome === 'error' ? 'error' : 'warning';
    const extra = r.outcome === 'error'
      ? ' ERROR also implies an Incident should be filed (CGAD P8).'
      : '';
    findings.push({
      rule: "CGAD-R1",
      severity: sev,
      message: `evidence #${r.id} for task=${r.task_id} artifact=${r.artifact_id} has outcome='${r.outcome}'; deny-by-default (CGAD P14) — this evidence cannot admit a transition.${extra}`,
      location: `verification_evidence.id=${r.id}`,
      provenance: r.recorded_by || "(none)",
    });
  }

  // R1b: missing provenance — UNKNOWN under P13/P14.
  const noProv = db.prepare(`
    SELECT ve.id, ve.task_id, ve.artifact_id, ve.outcome, ve.created_at
    FROM verification_evidence ve
    JOIN tasks t ON t.id = ve.task_id
    WHERE (ve.recorded_by IS NULL OR ve.recorded_by = '') ${pj}
    ORDER BY ve.id`).all();
  for (const r of noProv) {
    findings.push({
      rule: "CGAD-R1",
      severity: "warning",
      message: `evidence #${r.id} for task=${r.task_id} has no recorded_by; under CGAD P13/P14 this is UNKNOWN (deny), not PASS.`,
      location: `verification_evidence.id=${r.id}`,
      provenance: "(none)",
    });
  }

  // R1c: missing provider — informational; REQ-008 column, gradual backfill.
  // Only check if the column exists (post-migration DBs).
  try {
    const noProvider = db.prepare(`
      SELECT ve.id, ve.task_id, ve.outcome, ve.recorded_by
      FROM verification_evidence ve
      JOIN tasks t ON t.id = ve.task_id
      WHERE ve.provider IS NULL ${pj}
      ORDER BY ve.id`).all();
    for (const r of noProvider) {
      findings.push({
        rule: "CGAD-R1",
        severity: "warning",
        message: `evidence #${r.id} for task=${r.task_id} has no provider; CGAD §6 requires every guard input to come from a registered Trusted Guard Input Provider. Backfill via verification_record({provider: '...'}) is gradual.`,
        location: `verification_evidence.id=${r.id}`,
        provenance: `recorded_by=${r.recorded_by || "(none)"}`,
      });
    }
  } catch {
    // Pre-REQ-008 DB without provider column — skip silently.
  }

  return findings;
}

// R2 — P15 risk floor (REQ-009 strengthened).
// Two checks:
//   R2a (legacy, still applies): tasks tagged critical/security with priority
//        in {low, medium} — the legacy column betrays the tag.
//   R2b (REQ-009 new): tasks where final_risk IS NOT NULL but
//        final_risk < max(declared_risk, derived_risk, policy_minimum) by
//        severity order. CGAD P15: the agent cannot self-lower final_risk
//        below the derived floor or the policy floor. If final_risk is lower
//        than the computed max, the row was hand-edited past the computation.
//        Also catches final_risk NULL when derived or policy are set (the
//        computation should have filled it in).
function ruleR2(db, projectId) {
  const pj = projectFilter(projectId, "tasks");
  const findings = [];

  // R2a: legacy — tag/priority mismatch.
  const critical = db.prepare(`
    SELECT id, title, priority, tags
    FROM tasks
    WHERE ((',' || tags || ',') LIKE '%,critical,%'
       OR (',' || tags || ',') LIKE '%role:critical,%'
       OR (',' || tags || ',') LIKE '%security%')
      AND priority IN ('low','medium')
      ${pj}
    ORDER BY id`).all();
  for (const r of critical) {
    findings.push({
      rule: "CGAD-R2",
      severity: "error",
      message: `task #${r.id} "${r.title}" is tagged critical/security but has priority='${r.priority}'. P15: final risk cannot be self-lowered below the critical floor. Raise priority to high or critical, or remove the critical/security tag with explicit authority.`,
      location: `tasks.id=${r.id}`,
      provenance: `tags=${r.tags || "(none)"}`,
    });
  }

  // R2b: REQ-009 — final_risk consistency. Try the new columns; skip silently
  // if pre-REQ-009 DB lacks them.
  try {
    const rows = db.prepare(`
      SELECT id, title, declared_risk, derived_risk, policy_minimum, final_risk
      FROM tasks
      WHERE (declared_risk IS NOT NULL OR derived_risk IS NOT NULL OR policy_minimum IS NOT NULL)
        ${pj}
      ORDER BY id`).all();
    const rank = { low: 0, medium: 1, high: 2, critical: 3 };
    for (const r of rows) {
      const candidates = [r.declared_risk, r.derived_risk, r.policy_minimum]
        .filter(v => v != null && v in rank);
      if (candidates.length === 0) continue;
      const expected = candidates.reduce((m, v) => Math.max(m, rank[v]), -1);
      const expectedLevel = expected >= 0 ? ['low','medium','high','critical'][expected] : null;
      if (r.final_risk === null) {
        findings.push({
          rule: "CGAD-R2",
          severity: "error",
          message: `task #${r.id} "${r.title}" has risk columns set (declared=${r.declared_risk}, derived=${r.derived_risk}, policy=${r.policy_minimum}) but final_risk is NULL. The computation (max of three) should have filled it in. Likely a backfill gap or hand-edit.`,
          location: `tasks.id=${r.id}`,
          provenance: `declared=${r.declared_risk}, derived=${r.derived_risk}, policy=${r.policy_minimum}, final=NULL (expected ${expectedLevel})`,
        });
      } else if (rank[r.final_risk] < expected) {
        findings.push({
          rule: "CGAD-R2",
          severity: "error",
          message: `task #${r.id} "${r.title}" has final_risk='${r.final_risk}' but max(declared=${r.declared_risk}, derived=${r.derived_risk}, policy=${r.policy_minimum})='${expectedLevel}'. CGAD P15 VIOLATION: agent cannot self-lower final_risk below derived or policy floor.`,
          location: `tasks.id=${r.id}`,
          provenance: `declared=${r.declared_risk}, derived=${r.derived_risk}, policy=${r.policy_minimum}, final=${r.final_risk} (expected ${expectedLevel})`,
        });
      }
    }
  } catch {
    // Pre-REQ-009 DB without risk columns — skip R2b silently.
  }

  return findings;
}

// R3 — GUARDRAILS Sign 006: AC coverage ≠ AC satisfaction.
// Every accepted AC with an `implements` trace must also have at least one
// `verified_by` trace to a task whose verification_evidence.outcome='passed'.
function ruleR3(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : `AND a.project_id IS NOT NULL`; // include all if no filter
  const findings = [];

  // Accepted ACs with implements but no verified_by at all.
  const acs = db.prepare(`
    SELECT a.id AS ac_id, a.code AS ac_code, a.path AS ac_path,
      (SELECT COUNT(*) FROM artifact_traces t WHERE t.source_id = a.id AND t.link_type = 'implements') AS impl_n,
      (SELECT COUNT(*) FROM artifact_traces t WHERE t.source_id = a.id AND t.link_type = 'verified_by') AS vb_n
    FROM artifacts a
    WHERE a.type = 'AC'
      AND a.status = 'accepted'
      ${pj}
    ORDER BY a.id`).all();

  for (const r of acs) {
    if (r.impl_n > 0 && r.vb_n === 0) {
      findings.push({
        rule: "CGAD-R3",
        severity: "error",
        message: `accepted ${r.ac_code || "AC#" + r.ac_id} (${r.ac_path}) has ${r.impl_n} implements trace(s) but 0 verified_by traces. GUARDRAILS Sign 006: implements is structural coverage, not satisfaction. The AC is not provably satisfied; its episode's integration gate should deny.`,
        location: `artifacts.id=${r.ac_id}`,
        provenance: `implements=${r.impl_n}, verified_by=${r.vb_n}`,
      });
    } else if (r.impl_n > 0 && r.vb_n > 0) {
      // Check that the verified_by target task has passing evidence.
      const vbTargets = db.prepare(`
        SELECT t.target_id AS task_id, ta.status AS task_status,
          (SELECT ve.outcome FROM verification_evidence ve
            WHERE ve.task_id = t.target_id AND ve.artifact_id = a.id
            ORDER BY ve.id DESC LIMIT 1) AS latest_outcome
        FROM artifact_traces t
        LEFT JOIN tasks ta ON ta.id = t.target_id
        CROSS JOIN artifacts a ON a.id = t.source_id
        WHERE t.source_id = ? AND t.link_type = 'verified_by' AND a.id = ?`).all(r.ac_id, r.ac_id);
      const nonePassed = vbTargets.length > 0 && vbTargets.every(v => v.latest_outcome !== 'passed');
      if (nonePassed) {
        findings.push({
          rule: "CGAD-R3",
          severity: "error",
          message: `${r.ac_code || "AC#" + r.ac_id} has verified_by traces but none resolve to passing verification_evidence for this AC. Sign 006: satisfaction requires a passed evidence row tied to the AC, not just a trace.`,
          location: `artifacts.id=${r.ac_id}`,
          provenance: `verified_by targets=${vbTargets.length}, none with latest_outcome='passed'`,
        });
      }
    }
  }

  return findings;
}

// R4 — GUARDRAILS Sign 002 + CGAD §22 forbidden construct §34:
// "Git conflict as only conflict detector". Pattern B (scaffold-then-parallel)
// must be used when ≥2 parallel git_change tasks share a module on a greenfield
// episode. Without a SCAFFOLD task in the dependency closure, the only thing
// stopping two workers from racing on the same files is git's merge conflict
// detector — exactly what CGAD §34 forbids.
//
// Heuristic (intentionally conservative — false negatives are acceptable,
// false positives are not, because R4 is the prevention gate):
//   1. Episode has reached `development` stage or beyond.
//   2. Episode has ≥2 git_change tasks in development/integration stage.
//   3. No task in the episode carries tag `scaffold` OR has a title starting
//      with `SCAFFOLD:` (the saga-planner convention).
//   4. The episode has at least one prior merged task in the same repository
//      OR the tasks are tagged `greenfield` — wait, INVERTED: greenfield means
//      NO prior merged tasks, which is when scaffold is most needed.
//
// Refined: fire when episode is greenfield (no prior merged git_change task in
// the project_repository) AND ≥2 parallel git_change tasks without a scaffold
// dependency. Episodes that are NOT greenfield (existing codebase) get a pass
// because the shared contract already exists in code.
function ruleR4(db, projectId) {
  const pj = projectId !== undefined
    ? `AND e.project_id = ${Number(projectId)}`
    : '';
  const findings = [];

  // Episodes in development-or-later stage.
  const episodes = db.prepare(`
    SELECT ew.epic_id, ew.stage, e.name, e.project_id
    FROM episode_workflows ew
    JOIN epics e ON e.id = ew.epic_id
    WHERE ew.stage IN ('development','verification','integration','completed')
    ${pj}
    ORDER BY ew.epic_id`).all();

  for (const ep of episodes) {
    // All development/integration git_change tasks for this episode.
    const tasks = db.prepare(`
      SELECT t.id, t.title, t.status, t.project_repository_id, t.tags,
             t.source_ref, t.integration_state
      FROM tasks t
      WHERE t.epic_id = ?
        AND t.execution_mode = 'git_change'
        AND t.workflow_stage IN ('development','integration')`).all(ep.epic_id);

    if (tasks.length < 2) continue;

    // Does the episode have a scaffold task? saga-planner convention:
    // tag contains 'scaffold' OR title starts with 'SCAFFOLD:'.
    const hasScaffold = tasks.some(t => {
      const tags = String(t.tags || '[]');
      const title = String(t.title || '');
      return tags.includes('scaffold') || title.startsWith('SCAFFOLD:');
    });
    if (hasScaffold) continue;

    // Is this greenfield? Check the project_repository for any prior merged
    // task NOT in this episode. If there are zero prior merges, the codebase
    // is greenfield from this episode's perspective.
    const repoIds = [...new Set(
      tasks.map(t => t.project_repository_id).filter(Number.isFinite)
    )];
    let isGreenfield = true;
    if (repoIds.length === 0) {
      // No repository binding — legacy episode. We cannot prove it is
      // established, and CGAD §34 / Sign 002 say: when in doubt, require
      // scaffold (false-positive cheaper than false-negative for a
      // prevention gate). So treat as greenfield.
      isGreenfield = true;
    } else {
      const placeholders = repoIds.map(() => '?').join(',');
      const priorMerges = db.prepare(`
        SELECT COUNT(*) AS n FROM tasks
        WHERE project_repository_id IN (${placeholders})
          AND integration_state = 'merged'
          AND epic_id != ?`).get(...repoIds, ep.epic_id);
      isGreenfield = priorMerges.n === 0;
    }
    if (!isGreenfield) continue; // established codebase — shared contract exists in code

    // Module overlap heuristic: do ≥2 tasks share a source_ref path?
    // If tasks have no source_ref at all (planner didn't set it), assume
    // overlap (conservative — forces scaffold when in doubt).
    // Two tasks touching the same file (full path match) is overlap; two
    // tasks in sibling files under the same directory is NOT overlap unless
    // they also share a module-tagged artifact.
    const refs = tasks.map(t => String(t.source_ref || '').trim()).filter(Boolean);
    let overlap = refs.length < tasks.length; // missing source_ref → assume overlap
    if (!overlap && refs.length >= 2) {
      // Same exact source_ref across two tasks is unambiguous overlap.
      const uniq = new Set(refs);
      overlap = uniq.size < refs.length;
    }
    if (!overlap) continue;

    findings.push({
      rule: "CGAD-R4",
      severity: "error",
      message: `episode #${ep.epic_id} "${ep.name}" is in stage '${ep.stage}' with ${tasks.length} parallel git_change tasks but no scaffold task. GUARDRAILS Sign 002 + CGAD §34: parallel implementation before a frozen contract snapshot produces add/add merge conflicts that git cannot resolve. Re-plan with Pattern B (scaffold-then-parallel) or tag tasks ['cgad-r4-waived'] with a justification.`,
      location: `episode_workflows.epic_id=${ep.epic_id}`,
      provenance: `tasks=[${tasks.map(t => '#' + t.id).join(',')}], stage=${ep.stage}, repo_ids=[${repoIds.join(',') || 'none'}]`,
    });
  }

  return findings;
}

// R5 — CGAD §34 + REQ-010 — semantic collisions on active tasks.
// Two ACTIVE tasks sharing a (key_type, key_value) pair in task_conflict_keys
// collide semantically. The episode must either resolve the collision
// (Pattern B scaffold, depends_on sequencing, scope split) or waive it
// explicitly. Without R5, the collision is detected only when git merge
// fails — which is exactly what CGAD §34 forbids.
//
// Severity policy:
//   - 2 tasks colliding → warning (likely Pattern B or sequence resolves it)
//   - 3+ tasks colliding → error (scaffold MANDATORY)
//   - Any collision where one task is already in_progress AND another is
//     todo/in_progress → error (race condition in flight)
function ruleR5(db, projectId) {
  const pj = projectId !== undefined
    ? `AND t.epic_id IN (SELECT id FROM epics WHERE project_id = ${Number(projectId)})`
    : '';
  const findings = [];

  // Detect collisions on epic scope. We group by (epic_id, key_type, key_value)
  // so the finding is scoped to a single episode (cross-episode collisions
  // are a different problem — those are repository-scope, queried via the
  // conflict_check tool, not lint).
  let rows;
  try {
    rows = db.prepare(`
      SELECT k.key_type, k.key_value,
             e.id AS epic_id, e.name AS epic_name,
             GROUP_CONCAT(k.task_id) AS task_ids_csv,
             COUNT(DISTINCT k.task_id) AS n_tasks,
             SUM(CASE WHEN t.status IN ('in_progress','review_in_progress') THEN 1 ELSE 0 END) AS n_active_running,
             SUM(CASE WHEN t.status IN ('todo','in_progress','review','review_in_progress','blocked') THEN 1 ELSE 0 END) AS n_active
      FROM task_conflict_keys k
      JOIN tasks t ON t.id = k.task_id
      JOIN epics e ON e.id = t.epic_id
      WHERE t.status IN ('todo','in_progress','review','review_in_progress','blocked')
      ${pj}
      GROUP BY e.id, k.key_type, k.key_value
      HAVING n_active >= 2
      ORDER BY n_active DESC, e.id, k.key_type`).all();
  } catch {
    // Pre-REQ-010 DB without task_conflict_keys — skip silently.
    return findings;
  }

  for (const r of rows) {
    const taskIds = r.task_ids_csv.split(',').map((s) => Number(s));
    const inFlight = r.n_active_running >= 2
      || (r.n_active_running >= 1 && r.n_active >= 2);
    let severity;
    if (r.n_tasks >= 3 || inFlight) {
      severity = 'error';
    } else {
      severity = 'warning';
    }
    const extra = inFlight
      ? ' TWO OR MORE tasks are already in_progress/review_in_progress — this is a live race, not a planning risk.'
      : '';
    findings.push({
      rule: 'CGAD-R5',
      severity,
      message: `semantic collision in episode #${r.epic_id} "${r.epic_name}": ${r.n_tasks} active tasks share ${r.key_type}="${r.key_value}". CGAD §34: git conflict must not be the only detector. Resolve via Pattern B scaffold, depends_on sequencing, or scope split.${extra}`,
      location: `epic=${r.epic_id}, key=${r.key_type}:${r.key_value}`,
      provenance: `tasks=[${taskIds.join(',')}], in_flight=${r.n_active_running}`,
    });
  }

  return findings;
}

// R6 — CGAD §22 §26: agent self-sets state. Tasks must NOT mutate their own
// workflow_stage outside the dispatcher. We detect the symptom: a task whose
// status moved backwards (e.g. done -> in_progress) without an activity_log
// 'status_changed' entry from dispatcher. This is heuristic — we flag any
// task whose updated_at > created_at + 1s AND no activity_log entry exists
// for that task after created_at. False positives possible (manual admin);
// severity is warning.
function ruleR6(db, projectId) {
  const pj = projectId !== undefined
    ? `AND t.epic_id IN (SELECT id FROM epics WHERE project_id = ${Number(projectId)})`
    : '';
  const findings = [];
  // Find tasks where activity_log has no entry for that task at all.
  const rows = db.prepare(`
    SELECT t.id, t.title, t.status, t.created_at, t.updated_at,
      (SELECT COUNT(*) FROM activity_log a WHERE a.entity_type='task' AND a.entity_id=t.id) AS log_n
    FROM tasks t
    WHERE t.updated_at > datetime(t.created_at, '+5 seconds')
      AND t.status NOT IN ('todo')
      ${pj}
    ORDER BY t.id`).all();
  for (const r of rows) {
    if (r.log_n === 0) {
      findings.push({
        rule: 'CGAD-R6',
        severity: 'warning',
        message: `task #${r.id} "${r.title}" has status='${r.status}' and updated_at > created_at, but ZERO activity_log entries. CGAD §26: an agent must not self-set its own state — transitions are recorded in the Workflow Ledger. Either this task was modified out-of-band, or activity logging is broken.`,
        location: `tasks.id=${r.id}`,
        provenance: `status=${r.status}, log_entries=${r.log_n}`,
      });
    }
  }
  return findings;
}

// R7 — CGAD §22 §29: non-atomic commit of a transition. Heuristic: episode
// workflow stage changes leave an activity_log 'status_changed' entry with
// field 'episode_stage'. If an episode_workflows.updated_at advanced but no
// matching log entry exists for that epic, the transition bypassed the
// normal path. (SQL CHECK constraint already enforces atomicity inside one
// statement; this catches application-level non-atomic patterns.)
function ruleR7(db, projectId) {
  const pj = projectId !== undefined
    ? `AND ew.epic_id IN (SELECT id FROM epics WHERE project_id = ${Number(projectId)})`
    : '';
  const findings = [];
  const rows = db.prepare(`
    SELECT ew.epic_id, ew.stage, ew.updated_at,
      (SELECT COUNT(*) FROM activity_log a
        WHERE a.entity_type='epic' AND a.entity_id=ew.epic_id
          AND a.field_name='episode_stage') AS stage_log_n
    FROM episode_workflows ew
    WHERE ew.stage != 'discovery'
      ${pj}`).all();
  for (const r of rows) {
    if (r.stage_log_n === 0) {
      findings.push({
        rule: 'CGAD-R7',
        severity: 'warning',
        message: `episode #${r.epic_id} reached stage '${r.stage}' with no episode_stage transition in activity_log. CGAD §29: transitions must be atomic AND audited. Possible bypass of episode_transition tool.`,
        location: `episode_workflows.epic_id=${r.epic_id}`,
        provenance: `stage=${r.stage}, stage_log_entries=${r.stage_log_n}`,
      });
    }
  }
  return findings;
}

// R8 — CGAD §22 §32: editing Frozen ContractVersion in place. An artifact
// with status='accepted' whose accepted_hash differs from content_hash has
// drifted — exactly what drift_state='drifted' tracks. The schema already
// records this; R8 surfaces it as a CGAD finding (not just an internal flag).
function ruleR8(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : '';
  const findings = [];
  const rows = db.prepare(`
    SELECT a.id, a.code, a.path, a.status, a.drift_state,
           a.accepted_hash, a.content_hash
    FROM artifacts a
    WHERE a.status = 'accepted'
      AND a.drift_state = 'drifted'
      ${pj}
    ORDER BY a.id`).all();
  for (const r of rows) {
    findings.push({
      rule: 'CGAD-R8',
      severity: 'error',
      message: `accepted ${r.code || 'artifact #' + r.id} (${r.path}) has drift_state='drifted' — accepted_hash=${r.accepted_hash?.slice(0, 10)}... but content_hash=${r.content_hash?.slice(0, 10)}.... CGAD §32: a Frozen ContractVersion must not be edited in place. Either restore the file to match accepted_hash, or supersede the artifact via a new accepted revision.`,
      location: `artifacts.id=${r.id}`,
      provenance: `status=${r.status}, drift=${r.drift_state}`,
    });
  }
  return findings;
}

// R9 — CGAD §22 §39 + P7: self-approval. A verification_evidence row whose
// recorded_by is the SAME worker_id that built the task (i.e. the dev task's
// assigned_to) is a self-approval. The verifier must be a different agent
// than the builder. We approximate: for each verification_evidence row,
// check if recorded_by === the dev task's assigned_to for the same artifact
// in the same episode. False negatives possible (worker_id may differ when
// the same agent used a different ID), but the structural check catches the
// common case.
function ruleR9(db, projectId) {
  const pj = projectId !== undefined
    ? `AND t_verify.epic_id IN (SELECT id FROM epics WHERE project_id = ${Number(projectId)})`
    : '';
  const findings = [];
  // For each verification_evidence row, find the dev task that implements
  // the same AC, and check if recorded_by matches its assigned_to.
  const rows = db.prepare(`
    SELECT DISTINCT ve.id AS ve_id, ve.task_id AS verify_task_id, ve.recorded_by,
           ve.artifact_id, t_verify.epic_id
    FROM verification_evidence ve
    JOIN tasks t_verify ON t_verify.id = ve.task_id
    WHERE ve.recorded_by IS NOT NULL
      ${pj}`).all();
  for (const r of rows) {
    // Find dev tasks implementing the same artifact in the same episode.
    const devTasks = db.prepare(`
      SELECT t.id, t.assigned_to
      FROM artifact_traces tr
      JOIN tasks t ON t.id = tr.target_id AND tr.target_type='task'
      WHERE tr.source_id=? AND tr.link_type='implements'
        AND t.epic_id=?`).all(r.artifact_id, r.epic_id);
    for (const d of devTasks) {
      if (d.assigned_to && d.assigned_to === r.recorded_by) {
        findings.push({
          rule: 'CGAD-R9',
          severity: 'error',
          message: `verification_evidence #${r.ve_id} (task=${r.verify_task_id}) was recorded_by '${r.recorded_by}', which is ALSO the assigned_to of dev task #${d.id} that implements the same AC. CGAD §39 / P7: no self-approval — Verifier must be a different agent than Builder.`,
          location: `verification_evidence.id=${r.ve_id}`,
          provenance: `verify_task=${r.verify_task_id}, dev_task=${d.id}, both assigned_to='${r.recorded_by}'`,
        });
        break; // one finding per evidence row is enough
      }
    }
  }
  return findings;
}

// R10 — CGAD §22 §42: Work Package self-decomposition. A task's
// generated_from_task_id must NOT equal its own id (trivially impossible at
// insert, but a corrupted DB or a future bug could create it). We also flag
// cycles: A.generated_from_task_id = B AND B.generated_from_task_id = A.
function ruleR10(db, projectId) {
  const pjSelf = projectId !== undefined
    ? `AND epic_id IN (SELECT id FROM epics WHERE project_id = ${Number(projectId)})`
    : '';
  const pjCycle = projectId !== undefined
    ? `AND a.epic_id IN (SELECT id FROM epics WHERE project_id = ${Number(projectId)})`
    : '';
  const findings = [];
  // Self-loop.
  const selfLoops = db.prepare(`
    SELECT id, title, generated_from_task_id FROM tasks
    WHERE generated_from_task_id = id ${pjSelf}`).all();
  for (const r of selfLoops) {
    findings.push({
      rule: 'CGAD-R10',
      severity: 'error',
      message: `task #${r.id} "${r.title}" has generated_from_task_id = itself. CGAD §42: a Work Package must not self-decompose.`,
      location: `tasks.id=${r.id}`,
      provenance: `generated_from_task_id=${r.generated_from_task_id}`,
    });
  }
  // 2-cycle.
  const twoCycles = db.prepare(`
    SELECT a.id AS a_id, a.title AS a_title,
           b.id AS b_id, b.title AS b_title
    FROM tasks a JOIN tasks b
      ON a.generated_from_task_id = b.id AND b.generated_from_task_id = a.id
    WHERE a.id < b.id ${pjCycle}`).all();
  for (const r of twoCycles) {
    findings.push({
      rule: 'CGAD-R10',
      severity: 'error',
      message: `decomposition cycle: task #${r.a_id} → #${r.b_id} → #${r.a_id}. CGAD §42: Work Package self-decomposition (including indirect cycles) is forbidden.`,
      location: `tasks.id=${r.a_id}`,
      provenance: `cycle=${r.a_id}<->${r.b_id}`,
    });
  }
  return findings;
}

// R11 — CGAD §22 §46: hidden exception without owner/expiry/review. The
// saga equivalent of an exception is the needs-human tag (added by
// worker_ask_need / worker_merge_release on conflict). An exception without
// owner (assigned_to IS NULL) or without a comment explaining it is a
// hidden exception.
function ruleR11(db, projectId) {
  const pj = projectId !== undefined
    ? `AND t.epic_id IN (SELECT id FROM epics WHERE project_id = ${Number(projectId)})`
    : '';
  const findings = [];
  const rows = db.prepare(`
    SELECT t.id, t.title, t.assigned_to, t.tags,
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_n
    FROM tasks t
    WHERE (',' || t.tags || ',') LIKE '%,needs-human,%'
      ${pj}
    ORDER BY t.id`).all();
  for (const r of rows) {
    if (!r.assigned_to && r.comment_n === 0) {
      findings.push({
        rule: 'CGAD-R11',
        severity: 'warning',
        message: `task #${r.id} "${r.title}" is tagged needs-human but has NO owner (assigned_to IS NULL) and NO comment. CGAD §46: every exception must have owner, reason, and review condition. Re-assign the task or document the blocker in a comment.`,
        location: `tasks.id=${r.id}`,
        provenance: `assigned_to=NULL, comments=${r.comment_n}`,
      });
    }
  }
  return findings;
}

// R12 — CGAD §22 §43: human approval as proof of correctness. A verified_by
// trace whose target task is NOT a verification.ac task means a regular dev
// task (or a human-only approval flow) is being credited as Verifier
// evidence. Only verification.ac tasks may produce verified_by traces.
function ruleR12(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : '';
  const findings = [];
  const rows = db.prepare(`
    SELECT tr.id AS trace_id, tr.source_id AS ac_id, tr.target_id AS task_id,
           t.task_kind, t.title
    FROM artifact_traces tr
    JOIN artifacts a ON a.id = tr.source_id
    LEFT JOIN tasks t ON t.id = tr.target_id
    WHERE tr.link_type = 'verified_by'
      AND (t.task_kind IS NULL OR t.task_kind != 'verification.ac')
      ${pj}`).all();
  for (const r of rows) {
    findings.push({
      rule: 'CGAD-R12',
      severity: 'error',
      message: `verified_by trace #${r.trace_id} points to task #${r.task_id} "${r.title}" (task_kind=${r.task_kind || 'NULL'}). CGAD §43: human approval or builder work is NOT proof of correctness. Only verification.ac tasks may carry verified_by traces. Re-record the evidence via a verification.ac task.`,
      location: `artifact_traces.id=${r.trace_id}`,
      provenance: `target_task=${r.task_id}, task_kind=${r.task_kind || 'NULL'}`,
    });
  }
  return findings;
}

// ---------- Output formatting ----------

function severityRank(s) { return { error: 0, warning: 1, info: 2 }[s] ?? 3; }

function emitText(findings, dbPath, projectId) {
  const errors = findings.filter(f => f.severity === "error");
  const warnings = findings.filter(f => f.severity === "warning");
  const lines = [];
  lines.push(`cgad-spec-lint v0.1 — ${dbPath}${projectId !== undefined ? ` (project_id=${projectId})` : ""}`);
  lines.push(`${LINTER_VERSION}`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("No findings. (Note: 3 rules audited; see ADR-005 Roadmap for the full CGAD scope.)");
  } else {
    for (const f of [...errors, ...warnings].sort((a,b) => severityRank(a.severity) - severityRank(b.severity))) {
      lines.push(`[${f.severity.toUpperCase()}] ${f.rule} — ${f.location}`);
      lines.push(`  ${f.message}`);
      lines.push(`  provenance: ${f.provenance}`);
      lines.push("");
    }
  }
  lines.push(`Summary: ${errors.length} error(s), ${warnings.length} warning(s).`);
  lines.push(`Per GUARDRAILS Sign 008: this audit is descriptive; passing it does not imply CGAD compliance.`);
  return lines.join("\n");
}

function emitJson(findings, dbPath, projectId) {
  return JSON.stringify({
    linter: LINTER_VERSION,
    db: dbPath,
    project_id: projectId ?? null,
    rule_set: "cgad-v1.0",
    rules: ["CGAD-R1", "CGAD-R2", "CGAD-R3", "CGAD-R4", "CGAD-R5",
            "CGAD-R6", "CGAD-R7", "CGAD-R8", "CGAD-R9", "CGAD-R10",
            "CGAD-R11", "CGAD-R12"],
    findings,
    summary: {
      errors: findings.filter(f => f.severity === "error").length,
      warnings: findings.filter(f => f.severity === "warning").length,
    },
    note: "Per GUARDRAILS Sign 008: descriptive of saga's current partial CGAD compliance; not a CGAD-compliance claim.",
  }, null, 2);
}

function emitSarif(findings, dbPath) {
  return JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: { name: "cgad-spec-lint", version: "0.1.0", informationUri: "ADR-005" },
      },
      results: findings.map(f => ({
        ruleId: f.rule,
        level: f.severity === "error" ? "error" : "warning",
        message: { text: f.message },
        locations: [{ physicalLocation: { artifactLocation: { uri: dbPath } } }],
        partialFingerprints: { provenance: f.provenance },
      })),
    }],
  }, null, 2);
}

// ---------- main ----------

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n${usage()}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(usage() + "\n");
    process.exit(0);
  }

  let db;
  try {
    db = openDb(args.dbPath);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }
  let findings;
  try {
    findings = [
      ...ruleR1(db, args.projectId),
      ...ruleR2(db, args.projectId),
      ...ruleR3(db, args.projectId),
      ...ruleR4(db, args.projectId),
      ...ruleR5(db, args.projectId),
      ...ruleR6(db, args.projectId),
      ...ruleR7(db, args.projectId),
      ...ruleR8(db, args.projectId),
      ...ruleR9(db, args.projectId),
      ...ruleR10(db, args.projectId),
      ...ruleR11(db, args.projectId),
      ...ruleR12(db, args.projectId),
    ];
  } catch (e) {
    process.stderr.write(`error: rule evaluation failed: ${e.message}\n`);
    db.close();
    process.exit(2);
  }
  db.close();

  const out = args.format === "json"
    ? emitJson(findings, args.dbPath, args.projectId)
    : args.format === "sarif"
      ? emitSarif(findings, args.dbPath)
      : emitText(findings, args.dbPath, args.projectId);
  process.stdout.write(out + "\n");

  const hasErrors = findings.some(f => f.severity === "error");
  process.exit(hasErrors ? 1 : 0);
}

main();
