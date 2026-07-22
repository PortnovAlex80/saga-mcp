/**
 * Saga 3 — CLI entrypoint.
 *
 * Takes a mandate text, builds the episode, runs the engine.
 * When controller says did_work → spawns claude worker with skill prompt
 * → ingests output → condition True → next step.
 *
 * Usage:
 *   DB_PATH=~/.zcode/saga.db SAGA3_WORKSPACE=/path/to/repo \
 *     node dist/saga3/app/cli.js "Build a calculator app"
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EpisodeController } from './controller.js';
import { OracleRegistry } from '../evidence/attestation.js';
import { BudgetLedger } from '../budgets/budget-ledger.js';
import { allSkills } from '../executions/skill-registry.js';
import {
  PIPELINE_CONDITIONS,
  PIPELINE_ACTIONS,
  MANDATORY_CONDITIONS,
  initialConditions,
} from '../domain/pipeline-contracts.js';
import type { EpisodeContext } from './controller.js';
import type { WorkerOutput } from '../domain/types.js';
import { prodPorts } from '../adapters/prod-ports.js';
import { resolveSkill } from '../executions/assignment.js';
import { materializeWorkIntent } from '../work-intents/work-intent.js';

const mandate = process.argv[2];
if (!mandate) {
  console.error('Usage: node dist/saga3/app/cli.js "your mandate text"');
  process.exit(1);
}

const workspace = process.env.SAGA3_WORKSPACE ?? process.cwd();
if (!existsSync(workspace)) {
  console.error(`Workspace not found: ${workspace}`);
  process.exit(1);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// --- Build episode context ---

const spec = {
  id: `spec-${Date.now()}`,
  generation: 1,
  platformPolicyHash: sha256('platform-default'),
  constitutionHash: sha256(mandate),
  governanceHash: sha256('governance-default'),
  sourceBaseline: sha256('init'),
  environmentBaseline: process.platform,
  sealed: true,
};

const conditions = initialConditions(spec.id);
// MandatePresent = True (mandate was received).
const mandateCond = conditions.get('MandatePresent') as { status: string; sourceFingerprint: string | null };
mandateCond.status = 'True';
mandateCond.sourceFingerprint = sha256('init');

const oracleRegistry = new OracleRegistry();
for (const c of PIPELINE_CONDITIONS) {
  oracleRegistry.register({
    oracleId: c.oracleRequired,
    version: '1',
    trustClass: 'deterministic',
    scope: c.conditionType,
    proxyAllowed: false,
  });
}

const budget = new BudgetLedger(spec.id);
budget.allocate(10000);

// --- Skill prompt builder ---
// Maps conditionType → skill → prompt for the claude worker.

function buildSkillPrompt(conditionType: string, obligationId: string, skillId: string): string {
  const skills = allSkills();
  const skill = skills.find((s) => s.skillId === skillId);
  const role = skill?.role ?? 'worker';

  return [
    `You are a Saga 3 worker. Role: ${role}.`,
    `Task: produce the artifact for condition "${conditionType}" (obligation: ${obligationId}).`,
    `Workspace: ${workspace}`,
    ``,
    `Read your skill file at skills/${skillId}/SKILL.md for instructions.`,
    `Do the work according to the skill. When done, output:`,
    `1. The artifact file path and content.`,
    `2. A verification observation (what you checked).`,
    ``,
    `Output format (JSON):`,
    `{`,
    `  "result": "completed" | "failed",`,
    `  "artifacts": [{ "kind": "text", "path": "relative/path.md", "content": "..." }],`,
    `  "observations": [{ "oracleId": "...", "oracleVersion": "1", "command": "...", "verdict": "passed"|"failed"|"unknown", "stdout": "...", "exitCode": 0 }],`,
    `  "summary": "what you did"`,
    `}`,
  ].join('\n');
}

// --- Build ports ---

// We need a real DB for prodPorts, but for the walking skeleton we can use
// an in-memory approach. For now, create a minimal DB wrapper.
import Database from 'better-sqlite3';
const dbPath = process.env.DB_PATH;
let db: Database.Database;
if (dbPath && existsSync(dbPath)) {
  db = new Database(dbPath);
} else {
  // In-memory for testing
  db = new Database(':memory:');
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const ports = prodPorts(db, workspace);

// --- Build context ---

const ctx: EpisodeContext = {
  spec,
  conditionContracts: PIPELINE_CONDITIONS,
  actionContracts: PIPELINE_ACTIONS,
  conditions,
  skills: allSkills(),
  budget,
  oracleRegistry,
  currentSourceFingerprint: sha256('init'),
  currentEnvironmentFingerprint: process.platform,
  repositoryRoot: workspace,
  heldClaims: [],
  completedIntents: new Set(),
  dependencyEdges: [],
  certificate: null,
  leaseEpoch: 0,
  currentAssignment: null,
};

// --- Custom pump: did_work → spawn worker → ingest output ---

const controller = new EpisodeController(ports, ctx);

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function runEpisode(): Promise<void> {
  log(`Saga 3 starting. Mandate: ${mandate.slice(0, 80)}...`);
  log(`Workspace: ${workspace}`);
  log(`Conditions: ${PIPELINE_CONDITIONS.length} (${MANDATORY_CONDITIONS.length} mandatory)`);
  log('');

  let step = 0;
  const maxSteps = 200;

  while (step < maxSteps) {
    step++;

    let result;
    try {
      result = controller.stepEpisode();
    } catch (e) {
      log(`ERROR step ${step}: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    if (result.kind === 'terminal') {
      log(`TERMINAL: ${result.outcome} at step ${step}`);
      if (result.certificate) {
        log(`Certificate: satisfied=${result.certificate.satisfiedConditions.length}, unresolved=${result.certificate.unresolvedConditions.length}`);
        log(`Reason: ${result.certificate.causalReason}`);
      }
      break;
    }

    if (result.kind === 'quiescent') {
      log(`QUIESCENT at step ${step} — no deficits, but not terminal. Something is wrong.`);
      break;
    }

    if (result.kind === 'waiting_until') {
      // Brief wait then retry.
      await new Promise<void>((r) => setTimeout(r, 100));
      continue;
    }

    if (result.kind === 'did_work') {
      // The controller authorized work. Now we need to spawn a worker.
      const assignment = ctx.currentAssignment;
      if (!assignment) {
        log(`WARN: did_work but no assignment at step ${step}`);
        continue;
      }

      // Find the deficit condition that was addressed.
      const statuses: Record<string, string> = {};
      for (const [key, cond] of ctx.conditions) {
        statuses[key] = cond.status;
      }
      const deficits = Object.entries(statuses)
        .filter(([, s]) => s !== 'True')
        .map(([k]) => k);
      const targetCondition = deficits[0] ?? 'unknown';

      // Find the action contract for this condition.
      const action = PIPELINE_ACTIONS.find((a) => a.targetCondition === targetCondition);
      const skillId = action?.skillId ?? 'saga-worker';
      const obligationId = PIPELINE_CONDITIONS.find((c) => c.conditionType === targetCondition)?.obligationId ?? 'unknown';

      log(`STEP ${step}: condition=${targetCondition} skill=${skillId} — spawning worker...`);

      // Build the prompt for this condition.
      const prompt = buildSkillPrompt(targetCondition, obligationId, skillId);

      // Call the model port (real claude CLI).
      const deadline = ports.clock.deadline(300_000); // 5 min
      const modelResult = await ports.model.propose({
        role: resolveSkill(
          materializeWorkIntent({
            episodeSpecId: spec.id,
            generation: spec.generation,
            action: action!,
            obligationId,
            scopeType: 'episode',
            scopeId: '',
          }),
          ctx.skills,
        )?.role ?? 'worker',
        proposalKind: targetCondition,
        generation: spec.generation,
        inputFingerprint: ctx.currentSourceFingerprint,
        prompt,
      }, deadline);

      if (modelResult.kind !== 'proposal') {
        log(`WORKER FAILED: ${modelResult.kind}${'message' in modelResult ? ': ' + modelResult.message : ''}`);
        // Mark condition as Unknown (no evidence).
        const cond = ctx.conditions.get(targetCondition);
        if (cond) cond.status = 'Unknown';
        continue;
      }

      // Parse the worker output from the model result.
      const payload = modelResult.proposal.payload as Record<string, unknown>;
      const workerOutput: WorkerOutput = {
        assignmentId: assignment.id,
        workIntentId: '',
        result: ((payload.result as string) ?? 'completed') as 'completed' | 'failed' | 'ambiguous',
        artifacts: ((payload.artifacts as any[]) ?? []).map((a) => ({
          kind: a.kind ?? 'text',
          path: a.path ?? 'output.md',
          content: a.content ?? '',
          digest: a.digest ?? sha256(a.content ?? ''),
        })),
        observations: ((payload.observations as any[]) ?? []).map((o) => ({
          oracleId: o.oracleId ?? 'file-check',
          oracleVersion: o.oracleVersion ?? '1',
          command: o.command ?? '',
          verdict: o.verdict ?? 'unknown',
          rawDigest: o.rawDigest ?? sha256(o.stdout ?? ''),
          stdout: o.stdout ?? '',
          exitCode: o.exitCode ?? 0,
        })),
        summary: (payload.summary as string) ?? '',
      };

      // Ingest the worker output.
      const ingested = controller.ingestOutput(workerOutput, targetCondition, obligationId);

      log(`INGESTED: ${ingested.artifacts.length} artifacts, ${ingested.evidence.length} evidence`);
      for (const a of ingested.artifacts) {
        log(`  artifact: ${a.path} (${a.written ? 'written' : 'exists'})`);
      }
      for (const e of ingested.evidence) {
        log(`  evidence: ${e.oracleId} verdict=${e.verdict} trust=${e.trustClass}`);
      }

      const condAfter = ctx.conditions.get(targetCondition);
      log(`CONDITION ${targetCondition}: ${condAfter?.status}`);
      log('');

      // Mark this work as completed.
      ctx.completedIntents.add(assignment.id);
      ctx.currentAssignment = null;
    }
  }

  if (step >= maxSteps) {
    log(`MAX STEPS (${maxSteps}) reached without terminal.`);
  }

  log(`Episode finished after ${step} steps.`);
}

runEpisode().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
