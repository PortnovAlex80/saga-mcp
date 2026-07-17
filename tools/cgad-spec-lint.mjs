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
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const LINTER_VERSION = "cgad-spec-lint/1.4.0";

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
    "  CGAD-R13 Invariant enforcement (MVP). Accepted SRS with ZERO verification.ac",
    "           tasks in its episode. If SRS §2.3 declares invariants, they have",
    "           no enforcement path — no Independent Verifier will generate",
    "           property tests. Warning (not error) — invariants may be absent.",
    "  CGAD-R14 FR Forbidden Content (BABOK/Wiegers). Accepted FR artifact whose",
    "           .md doc leaks implementation detail: HTTP verbs (GET/POST/PUT/",
    "           DELETE/PATCH), DB table/column names, JSON field names, class or",
    "           method names, framework names (React/Django/Spring/Express), HTTP",
    "           status codes (401/403/404/500/...), or algorithm names",
    "           (SHA-256/HMAC/AES). Functional Requirements describe WHAT, not HOW.",
    "           Reads the artifact's .md from disk (path column or resolved via the",
    "           project_repository.local_path). Warning severity — FRs may",
    "           reference downstream SPECs by link without leaking their text.",
    "  CGAD-R15 RULE without enforcement (CGAD §9). Accepted artifact of type",
    "           'RULE' MUST have at least one outgoing trace with link_type",
    "           'implements' or 'implements_spec' (an FR or SPEC that operationalizes",
    "           the rule). A RULE with no enforcement path is an orphan — CGAD §9",
    "           requires every non-informational RULE to have an enforcement",
    "           mechanism. Warning severity — informational/policy RULEs may",
    "           legitimately have no implementer; the human reviews each finding.",
    "  CGAD-R16 Product cycle gap. Accepted 'hypothesis' artifact whose episode",
    "           has ZERO runtime observations. Product cycle incomplete — measure",
    "           the metric before declaring the hypothesis validated or refuted.",
    "  CGAD-R17 AC references test fixture/framework names. Acceptance criteria",
    "           are frozen contracts — FakeClock, stub, mock, pytest, Hypothesis",
    "           belong in the Verifier skill or SPEC, not in the AC the Builder",
    "           reads.",
    "  CGAD-R18 NFR mixes determinism/reproducibility with real-clock timing.",
    "           These are two concerns: (a) pure-core determinism (L3, FakeClock)",
    "           and (b) real-clock reproducibility (L4, best-effort). Split.",
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

// R13 — Invariant Registry enforcement (REQ-014 MVP).
// The SRS §2.3 Invariant Registry declares machine-checkable invariants per
// module. Each invariant MUST flow to: (a) at least one AC that verifies it,
// (b) a property test (L3) generated by an Independent Verifier.
//
// DB-level check (cannot read .md content directly): for each accepted SRS
// in scope, check that the episode has at least one verification.ac task.
// An accepted SRS with zero verification.ac tasks means no independent
// verification was planned — invariants declared in the SRS have no
// enforcement path.
//
// Future enhancement: when test_layer field exists on verification_evidence,
// R13 will check that each invariant has an L3 (property) evidence row,
// not just any verification task.
function ruleR13(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : '';
  const findings = [];

  // Find accepted SRS artifacts.
  const srsRows = db.prepare(`
    SELECT a.id AS srs_id, a.code, a.path, a.epic_id
    FROM artifacts a
    WHERE a.type = 'SRS' AND a.status = 'accepted'
    ${pj}`).all();

  for (const srs of srsRows) {
    // Check if this episode has any verification.ac tasks.
    const verifyCount = db.prepare(`
      SELECT COUNT(*) AS n FROM tasks
      WHERE epic_id = ? AND task_kind = 'verification.ac'`).get(srs.epic_id);

    if (verifyCount.n === 0) {
      findings.push({
        rule: 'CGAD-R13',
        severity: 'warning',
        message: `accepted SRS ${srs.code || '#' + srs.srs_id} (${srs.path}) in episode #${srs.epic_id} has ZERO verification.ac tasks. If the SRS §2.3 declares invariants, they have no enforcement path — no Independent Verifier will generate property tests. Create verification.ac tasks for each AC with a properties block.`,
        location: `artifacts.id=${srs.srs_id}`,
        provenance: `epic=${srs.epic_id}, verification.ac_tasks=0`,
      });
    }
  }

  return findings;
}

// R14 — FR Forbidden Content (BABOK/Wiegers-aligned requirements engineering).
//
// A Functional Requirement (FR) describes WHAT the system must do, not HOW.
// When an accepted FR's .md doc contains implementation detail (HTTP verbs,
// DB schema, JSON fields, class/method names, framework names, HTTP status
// codes, or algorithm names) the requirement has leaked design. Such FRs:
//   - prematurely constrain the solution space (the SRS/architecture work);
//   - couple the requirement to one implementation, so swapping it later
//     looks like a requirements change (CGAD §32 frozen-contract pain);
//   - bypass review of the actual design choice (it hides in the FR text).
//
// Severity is WARNING (not error): an FR may legitimately REFERENCE a SPEC by
// link, embed an illustrative example in a fenced block, or quote an external
// protocol. The human reviews each finding and either rewrites the FR to keep
// the WHAT/WHAT-HOW boundary clean or accepts the exception.
//
// Unlike R1–R13, R14 must READ the artifact .md from disk (the DB stores only
// the path + content_hash, not the body). Resolution order:
//   1. the artifact's `path` verbatim (absolute, or relative to cwd);
//   2. path joined with the bound project_repository.local_path;
//   3. path joined with each project_repository.local_path in scope (when no
//      artifact-level binding).
// Files that cannot be resolved are skipped silently (linter stays read-only
// and must not crash on a stale path).
//
// The forbidden-pattern set is intentionally short (5 groups, ~6 regexes). It
// catches the most common leaks; it is not exhaustive. Each finding names the
// pattern and one example match so the human can locate it in the doc.
function ruleR14(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : '';
  const findings = [];

  let frRows;
  try {
    frRows = db.prepare(`
      SELECT a.id AS fr_id, a.code, a.path, a.project_repository_id,
             a.project_id
      FROM artifacts a
      WHERE a.type = 'FR' AND a.status = 'accepted'
      ${pj}
      ORDER BY a.id`).all();
  } catch {
    // Pre-FR DB without the artifacts table — skip silently.
    return findings;
  }

  // Cache repository local_paths so we resolve each FR's .md once per repo.
  let repoPaths = [];
  try {
    repoPaths = db.prepare(
      `SELECT pr.id AS repo_id, pr.local_path
       FROM project_repositories pr`
    ).all().filter(r => r.local_path);
  } catch {
    repoPaths = [];
  }
  const repoById = new Map(repoPaths.map(r => [r.repo_id, r.local_path]));

  for (const fr of frRows) {
    const resolved = resolveArtifactFile(fr, repoById, repoPaths);
    if (!resolved) continue; // file not on disk — skip silently (read-only linter)
    let body;
    try {
      body = readFileSync(resolved, 'utf8');
    } catch {
      continue; // unreadable — skip
    }

    const hits = scanFrForbiddenContent(body);
    for (const h of hits) {
      findings.push({
        rule: 'CGAD-R14',
        severity: 'warning',
        message: `accepted FR ${fr.code || '#' + fr.fr_id} (${fr.path}) leaks implementation detail — ${h.label}: matched "${h.example}". BABOK/Wiegers: a Functional Requirement states WHAT; design choice belongs in the SRS/architecture. Rewrite to remove the leak, or move it to a SPEC and reference by link.`,
        location: `artifacts.id=${fr.fr_id}`,
        provenance: `pattern=${h.label}, file=${resolved}`,
      });
    }
  }

  return findings;
}

// R15 — RULE artifact without enforcement path (CGAD §9).
//
// A RULE artifact is a business rule / policy artifact (type='RULE'). CGAD §9
// requires every non-informational RULE to have an enforcement mechanism: an
// operationalization that turns the rule into something the system does. In
// the traceability graph that means at least one outgoing trace with
// link_type 'implements' (an FR that operationalizes the rule) OR
// 'implements_spec' (a SPEC design contract that implements the rule). A RULE
// with neither is an orphan — it states a policy but nothing in the system
// enforces it.
//
// Severity is WARNING (not error): a RULE may be intentionally informational
// (e.g. an org-wide compliance statement, a North-Star principle) and have no
// implementer by design. The human reviews each finding and either adds the
// missing trace or accepts the rule as informational.
//
// Detection is DB-only (no disk read): count outgoing traces from each accepted
// RULE with link_type IN ('implements','implements_spec'). If the count is 0,
// emit a finding.
function ruleR15(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : '';
  const findings = [];

  let ruleRows;
  try {
    ruleRows = db.prepare(`
      SELECT a.id AS rule_id, a.code, a.path
      FROM artifacts a
      WHERE a.type = 'RULE' AND a.status = 'accepted'
      ${pj}
      ORDER BY a.id`).all();
  } catch {
    // Pre-RULE DB without the 'RULE' type — skip silently.
    return findings;
  }

  for (const r of ruleRows) {
    // Outgoing traces with link_type 'implements' or 'implements_spec' = an
    // FR/SPEC that operationalizes this rule. Either link counts as enforcement.
    let enforcement;
    try {
      enforcement = db.prepare(`
        SELECT COUNT(*) AS n FROM artifact_traces
        WHERE source_id = ?
          AND link_type IN ('implements','implements_spec')`).get(r.rule_id);
    } catch {
      // Pre-migration DB where 'implements_spec' is not yet in the CHECK — fall
      // back to 'implements' only so R15 still runs on unmigrated DBs.
      enforcement = db.prepare(`
        SELECT COUNT(*) AS n FROM artifact_traces
        WHERE source_id = ? AND link_type = 'implements'`).get(r.rule_id);
    }
    if (enforcement.n === 0) {
      findings.push({
        rule: 'CGAD-R15',
        severity: 'warning',
        message: `accepted RULE ${r.code || '#' + r.rule_id} (${r.path}) has no enforcement path (no implements/implements_spec trace). Orphan rule — CGAD §9 requires every non-informational RULE to have an enforcement mechanism. Add an 'implements' trace to an operationalizing FR, or an 'implements_spec' trace to a SPEC design contract. If the RULE is intentionally informational, accept this warning.`,
        location: `artifacts.id=${r.rule_id}`,
        provenance: `implements=0, implements_spec=0`,
      });
    }
  }

  return findings;
}

// R16 — Product cycle gap: hypothesis without observation.
// For each accepted 'hypothesis' artifact: check if its epic has any
// runtime_observations. If zero → warning: product cycle incomplete.
function ruleR16(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : '';
  const findings = [];
  let hypRows;
  try {
    hypRows = db.prepare(`
      SELECT a.id AS hyp_id, a.code, a.epic_id
      FROM artifacts a
      WHERE a.type = 'hypothesis' AND a.status = 'accepted'
      ${pj}`).all();
  } catch {
    return findings; // pre-hypothesis-type DB
  }
  for (const h of hypRows) {
    let obsCount;
    try {
      obsCount = db.prepare('SELECT COUNT(*) AS n FROM runtime_observations WHERE epic_id=?').get(h.epic_id).n;
    } catch {
      obsCount = 0; // pre-observation table
    }
    if (obsCount === 0) {
      findings.push({
        rule: 'CGAD-R16',
        severity: 'warning',
        message: `accepted hypothesis ${h.code || '#' + h.hyp_id} in episode #${h.epic_id} has ZERO runtime observations. Product cycle incomplete — measure the metric before declaring the hypothesis validated or refuted.`,
        location: `artifacts.id=${h.hyp_id}`,
        provenance: `epic=${h.epic_id}, observations=0`,
      });
    }
  }
  return findings;
}

// R17 — AC references test fixture / test implementation names.
// Acceptance criteria are contracts, not test plans. They must not name
// FakeClock, stub, mock, test double, or any test-only artefact. That
// information belongs in the Verifier skill or a SPEC, not in the AC
// that the Builder reads as the frozen contract.
function ruleR17(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : '';
  const findings = [];

  let acRows;
  try {
    acRows = db.prepare(`
      SELECT a.id AS ac_id, a.code, a.path, a.project_repository_id
      FROM artifacts a
      WHERE a.type = 'AC' AND a.status = 'accepted'
      ${pj}`).all();
  } catch {
    return findings;
  }

  let repoPaths = [];
  try {
    repoPaths = db.prepare(
      `SELECT pr.id AS repo_id, pr.local_path FROM project_repositories pr`
    ).all().filter(r => r.local_path);
  } catch { repoPaths = []; }
  const repoById = new Map(repoPaths.map(r => [r.repo_id, r.local_path]));

  const TEST_FIXTURE_PATTERNS = [
    { label: 'test fixture name', regex: /\b(?:Fake[A-Z]\w*|Stub[A-Z]\w*|Mock[A-Z]\w*|TestDouble|fake_[a-z]|stub_[a-z]|mock_[a-z])\b/ },
    { label: 'test framework reference in contract', regex: /\b(?:pytest\.|unittest\.|Hypothesis|hypothesis|QuickCheck|jest\.|describe\(|it\(|test\()\b/ },
  ];

  for (const ac of acRows) {
    const resolved = resolveArtifactFile(ac, repoById, repoPaths);
    if (!resolved) continue;
    let body;
    try { body = readFileSync(resolved, 'utf8'); } catch { continue; }

    for (const p of TEST_FIXTURE_PATTERNS) {
      const m = p.regex.exec(body);
      if (m) {
        findings.push({
          rule: 'CGAD-R17',
          severity: 'warning',
          message: `accepted AC ${ac.code || '#' + ac.ac_id} references test fixture/framework: "${m[0]}" (${p.label}). AC is a frozen contract — test implementation details belong in the Verifier skill or SPEC, not in the AC the Builder reads.`,
          location: `artifacts.id=${ac.ac_id}`,
          provenance: `pattern=${p.label}, match=${m[0]}, file=${resolved}`,
        });
      }
    }
  }
  return findings;
}

// R18 — NFR mixes pure-core and real-clock concerns.
// Determinism / reproducibility NFRs often conflate two separate properties:
// (a) pure-core determinism (testable at L3 with FakeClock — INV-6 territory)
// (b) real-clock reproducibility (best-effort at L4 — wall-clock jitter breaks it)
// This rule flags NFRs containing 'determinism' or 'reproducibility' or 'identical'
// alongside clock/timing language, suggesting they should be split.
function ruleR18(db, projectId) {
  const pj = projectId !== undefined
    ? `AND a.project_id = ${Number(projectId)}`
    : '';
  const findings = [];

  let nfrRows;
  try {
    nfrRows = db.prepare(`
      SELECT a.id AS nfr_id, a.code, a.path, a.project_repository_id
      FROM artifacts a
      WHERE a.type = 'NFR' AND a.status = 'accepted'
      ${pj}`).all();
  } catch {
    return findings;
  }

  let repoPaths = [];
  try {
    repoPaths = db.prepare(
      `SELECT pr.id AS repo_id, pr.local_path FROM project_repositories pr`
    ).all().filter(r => r.local_path);
  } catch { repoPaths = []; }
  const repoById = new Map(repoPaths.map(r => [r.repo_id, r.local_path]));

  const DETERMINISM_RE = /\b(?:determinis|reproducib|identical\s+(?:run|sequence|result))\b/i;
  const CLOCK_RE = /\b(?:wall.?clock|real.?time|real.?clock|frame.?time|jitter|60\s*Hz|60\s*fps)\b/i;

  for (const nfr of nfrRows) {
    const resolved = resolveArtifactFile(nfr, repoById, repoPaths);
    if (!resolved) continue;
    let body;
    try { body = readFileSync(resolved, 'utf8'); } catch { continue; }

    // Read just the NFR's section (from code anchor to next code or EOF)
    const sectionRegex = new RegExp(
      `(?:${nfr.code || 'NFR-\\d+'}[^\n]*\n)([\\s\\S]*?)(?=\n(?:NFR|##|\Z))`,
      'i'
    );
    const sectionMatch = body.match(sectionRegex);
    const section = sectionMatch ? sectionMatch[1] : body.slice(0, 500);

    if (DETERMINISM_RE.test(section) && CLOCK_RE.test(section)) {
      findings.push({
        rule: 'CGAD-R18',
        severity: 'warning',
        message: `NFR ${nfr.code || '#' + nfr.nfr_id} mixes determinism/reproducibility with real-clock timing language. These are two separate concerns: (a) pure-core determinism (L3, testable with FakeClock) and (b) real-clock reproducibility (L4, best-effort). Split into two NFRs to avoid an unvervable requirement.`,
        location: `artifacts.id=${nfr.nfr_id}`,
        provenance: `determinism+clock in same section, file=${resolved}`,
      });
    }
  }
  return findings;
}

// Forbidden-content patterns for FR artifacts. Each entry: { label, regex }.
// `label` is the short human-readable category shown in the finding; `regex`
// is applied to the .md body. Patterns are kept tight to avoid English-prose
// false positives (e.g. HTTP verbs match uppercase only, since lower-case
// "get"/"put"/"post" are common verbs in well-written requirements). NO `g`
// flag: we only need the first match per pattern, and a stateful `g` regex
// shared across calls would advance lastIndex between invocations.
const FR_FORBIDDEN_PATTERNS = [
  // 1. HTTP verbs — uppercase only (English prose uses lowercase forms freely).
  {
    label: 'HTTP verb',
    regex: /\b(?:GET|POST|PUT|DELETE|PATCH)\b/,
  },
  // 2. Database schema — CREATE TABLE DDL, or backtick-quoted snake_case
  //    identifiers (the classic leak: `users`, `order_id`).
  {
    label: 'database schema',
    regex: /CREATE\s+TABLE|`[a-z][a-z0-9_]*`/i,
  },
  // 3. JSON / object field syntax — `"field":` or `"field_name" :`. Matches
  //    JSON/YAML/object-literal leaks; plain `field:` on a markdown line is
  //    too common in prose to flag reliably.
  {
    label: 'JSON field',
    regex: /"[a-z_][a-z0-9_]*"\s*:/i,
  },
  // 4. Class/method/function definitions — `ClassName.method(...)`,
  //    `def name(...)`, `function name(...)`. These are unambiguous code.
  {
    label: 'class or method name',
    regex: /\b[A-Z]\w+\.[a-z]\w+\s*\(|\bdef\s+[a-z_]\w+\s*\(|\bfunction\s+[a-z_$]\w*\s*\(/,
  },
  // 5. Framework names — explicit allowlist of common web/app frameworks.
  {
    label: 'framework name',
    regex: /\b(?:React|Vue|Angular|Django|Flask|FastAPI|Spring|Express|Rails|Laravel|Next\.js|Nest\.js|Svelte|Ember|Symfony|ASP\.NET)\b/,
  },
  // 6. HTTP status codes — curated common set (401/403/404/418/429/500/502/503).
  //    Bare 3-digit numbers would over-match (years, counts); the curated set
  //    keeps false positives near zero.
  {
    label: 'HTTP status code',
    regex: /\b(?:401|403|404|405|418|422|429|500|502|503|504)\b/,
  },
  // 7. Algorithm / crypto primitive names — concrete HOW for security-related
  //    FRs (e.g. "passwords must be SHA-256 hashed" couples the FR to a
  //    specific primitive; the choice belongs in the SRS).
  {
    label: 'algorithm name',
    regex: /\b(?:SHA-1|SHA-256|SHA-512|SHA-3|HMAC|AES|RSA|bcrypt|scrypt|Argon2|MD5|BLAKE2?|PBKDF2)\b/,
  },
];

// Apply every forbidden pattern to the body; return one entry per pattern that
// matched (with the first match as the example). Multiple distinct patterns
// produce multiple findings so the human sees each leak category separately.
function scanFrForbiddenContent(body) {
  const hits = [];
  for (const p of FR_FORBIDDEN_PATTERNS) {
    const m = p.regex.exec(body);
    if (m) {
      hits.push({ label: p.label, example: truncateMatch(m[0]) });
    }
  }
  return hits;
}

function truncateMatch(s) {
  const MAX = 60;
  return s.length > MAX ? s.slice(0, MAX) + '…' : s;
}

// Resolve an artifact's path to a file on disk. Tries the path verbatim, then
// joins it with the bound repository's local_path (if any), then with every
// other in-scope repository local_path. Returns the first existing file, or
// null if none can be read. Used by R14 to read FR .md docs from disk.
function resolveArtifactFile(artifact, repoById, repoPaths) {
  const p = String(artifact.path || '');
  if (!p) return null;

  // 1. Verbatim (absolute path or relative to cwd).
  if (existsSync(p)) return p;

  // 2. Bound repository local_path.
  if (artifact.project_repository_id != null) {
    const local = repoById.get(artifact.project_repository_id);
    if (local) {
      const joined = path.join(local, p);
      if (existsSync(joined)) return joined;
    }
  }

  // 3. Any other in-scope repository local_path (artifacts without a binding
  //    may still live under one of the registered repo roots).
  for (const r of repoPaths) {
    const joined = path.join(r.local_path, p);
    if (existsSync(joined)) return joined;
  }

  return null;
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
    rule_set: "cgad-v1.4",
    rules: ["CGAD-R1", "CGAD-R2", "CGAD-R3", "CGAD-R4", "CGAD-R5",
            "CGAD-R6", "CGAD-R7", "CGAD-R8", "CGAD-R9", "CGAD-R10",
            "CGAD-R11", "CGAD-R12", "CGAD-R13", "CGAD-R14", "CGAD-R15", "CGAD-R16",
            "CGAD-R17", "CGAD-R18"],
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
        driver: { name: "cgad-spec-lint", version: "1.3.0", informationUri: "ADR-005" },
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
      ...ruleR13(db, args.projectId),
      ...ruleR14(db, args.projectId),
      ...ruleR15(db, args.projectId),
      ...ruleR16(db, args.projectId),
      ...ruleR17(db, args.projectId),
      ...ruleR18(db, args.projectId),
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
