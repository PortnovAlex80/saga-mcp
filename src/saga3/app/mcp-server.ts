#!/usr/bin/env node
/**
 * Saga 3 — MCP server for claude workers.
 *
 * A stdio MCP server that exposes a small, deterministic tool surface so the
 * claude worker spawned by the saga3 engine can propose artifacts, propose
 * verification evidence, read the condition board, and complete conditions.
 *
 * It speaks ONLY to the saga3 tables (saga3_artifacts, saga3_evidence_records,
 * saga3_condition_instances, saga3_episode_specs). It deliberately imports
 * nothing from the legacy src/tools/* or src/orchestrate.ts — saga3 owns its
 * own control state and this server is its only LM-facing write path.
 *
 * Configuration (env):
 *   DB_PATH            — path to the sqlite DB (required).
 *   SAGA3_WORKSPACE    — workspace root; artifact paths are resolved under it.
 *
 * The server calls initSaga3Schema on startup so a fresh DB is bootstrapped.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initSaga3Schema } from '../domain/schema.js';
import { PIPELINE_CONDITIONS } from '../domain/pipeline-contracts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Fresh-line provenance for evidence: pulled from the frozen episode spec. */
interface EpisodeProvenance {
  generation: number;
  sourceFingerprint: string;
  environmentFingerprint: string;
}

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

let db: Database.Database;

function openDb(): Database.Database {
  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    throw new Error('DB_PATH env var is required for the saga3 MCP server.');
  }
  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  // Bootstraps the saga3 tables if missing; idempotent.
  initSaga3Schema(handle);
  return handle;
}

function workspaceRoot(): string {
  const ws = process.env.SAGA3_WORKSPACE ?? process.cwd();
  return ws;
}

function assertEpisodeScope(episodeSpecId: string): void {
  const assigned = process.env.SAGA3_EPISODE_SPEC_ID;
  if (assigned && assigned !== episodeSpecId) {
    throw new Error(`Worker is scoped to episode ${assigned}, not ${episodeSpecId}`);
  }
}

function assertConditionScope(conditionType: string): void {
  const assigned = process.env.SAGA3_CONDITION;
  if (assigned && assigned !== conditionType) {
    throw new Error(`Worker is scoped to condition ${assigned}, not ${conditionType}`);
  }
}

/**
 * Read generation + source/environment fingerprints for an episode.
 * Evidence provenance is ALWAYS controller-attached, never worker-supplied;
 * this lookup is how the server fills it.
 */
function episodeProvenance(episodeSpecId: string): EpisodeProvenance {
  const row = db
    .prepare(
      `SELECT generation, source_baseline, environment_baseline
         FROM saga3_episode_specs
        WHERE id = ?`,
    )
    .get(episodeSpecId) as
    | { generation: number; source_baseline: string | null; environment_baseline: string | null }
    | undefined;
  if (!row) {
    throw new Error(`Episode spec not found: ${episodeSpecId}`);
  }
  return {
    generation: row.generation,
    sourceFingerprint: row.source_baseline ?? '',
    environmentFingerprint: row.environment_baseline ?? '',
  };
}

/**
 * Look up the obligation_id for a (episode_spec_id, condition_type).
 * saga3_condition_instances' UNIQUE key includes obligation_id, so the worker
 * only names the condition_type and the server resolves the obligation.
 */
function obligationFor(episodeSpecId: string, conditionType: string): string {
  const row = db
    .prepare(
      `SELECT obligation_id
         FROM saga3_condition_instances
        WHERE episode_spec_id = ? AND condition_type = ?`,
    )
    .get(episodeSpecId, conditionType) as { obligation_id: string } | undefined;
  if (!row) {
    throw new Error(
      `Condition not found for episode ${episodeSpecId}: ${conditionType}`,
    );
  }
  return row.obligation_id;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

interface ProposeArtifactInput {
  episode_spec_id: string;
  kind: string;
  path: string;
  content: string;
  digest?: string;
}

function handleProposeArtifact(args: ProposeArtifactInput): { ok: true; artifact_id: string } {
  assertEpisodeScope(args.episode_spec_id);
  const digest = args.digest && args.digest.length > 0 ? args.digest : sha256(args.content ?? '');

  // Write content to disk under the workspace root (relative path resolved).
  const relativePath = args.path.split('#')[0]; // strip markdown anchor, matches ingestion.ts
  const root = path.resolve(workspaceRoot());
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`Artifact path escapes workspace: ${args.path}`);
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, args.content ?? '', 'utf8');

  const artifactId = `art-${randomUUID()}`;
  db.prepare(
    `INSERT INTO saga3_artifacts (id, episode_spec_id, kind, path, digest)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(episode_spec_id, path)
     DO UPDATE SET kind=excluded.kind, digest=excluded.digest`,
  ).run(artifactId, args.episode_spec_id, args.kind, args.path, digest);

  const stored = db.prepare(
    `SELECT id FROM saga3_artifacts WHERE episode_spec_id=? AND path=?`,
  ).get(args.episode_spec_id, args.path) as { id: string };
  return { ok: true, artifact_id: stored.id };
}

interface ProposeVerificationInput {
  episode_spec_id: string;
  condition_type: string;
  oracle_id: string;
  oracle_version: string;
  verdict: 'passed' | 'failed' | 'unknown' | 'error';
  stdout: string;
  exit_code: number;
}

function handleProposeVerification(args: ProposeVerificationInput): { ok: true; evidence_id: string } {
  assertEpisodeScope(args.episode_spec_id);
  assertConditionScope(args.condition_type);
  const contract = PIPELINE_CONDITIONS.find((item) => item.conditionType === args.condition_type);
  if (!contract || contract.oracleRequired !== args.oracle_id) {
    throw new Error(`Condition ${args.condition_type} requires oracle ${contract?.oracleRequired ?? 'unknown'}`);
  }
  if (args.verdict === 'passed' && args.exit_code !== 0) {
    throw new Error('A passed verdict requires exit_code=0.');
  }
  const prov = episodeProvenance(args.episode_spec_id);
  const obligationId = obligationFor(args.episode_spec_id, args.condition_type);

  const evidenceId = `ev-${randomUUID()}`;
  const rawDigest = sha256(args.stdout ?? '');
  // Freshness window mirrors the controller default (ingestObservation).
  const freshnessMaxAgeMs = 24 * 60 * 60 * 1000;
  // The pipeline registers every oracle as deterministic; without a registry
  // wired here we default to the same trust class.
  const trustClass = 'deterministic';

  db.prepare(
    `INSERT INTO saga3_evidence_records
       (id, episode_spec_id, condition_type, obligation_id, generation,
        source_fingerprint, environment_fingerprint, oracle_id, oracle_version,
        trust_class, verdict, raw_digest, observed_at, freshness_max_age_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    evidenceId,
    args.episode_spec_id,
    args.condition_type,
    obligationId,
    prov.generation,
    prov.sourceFingerprint,
    prov.environmentFingerprint,
    args.oracle_id,
    args.oracle_version,
    trustClass,
    args.verdict,
    rawDigest,
    Date.now(),
    freshnessMaxAgeMs,
  );

  return { ok: true, evidence_id: evidenceId };
}

interface ReadArtifactsInput {
  episode_spec_id?: string;
  path?: string;
}

interface ArtifactRow {
  id: string;
  episode_spec_id: string;
  kind: string;
  path: string;
  digest: string;
  created_at: string;
}

function handleReadArtifacts(args: ReadArtifactsInput): { artifacts: ArtifactRow[] } {
  let rows: ArtifactRow[];
  if (args.path) {
    rows = db
      .prepare(
        `SELECT id, episode_spec_id, kind, path, digest, created_at
           FROM saga3_artifacts
          WHERE path = ?
          ORDER BY created_at ASC`,
      )
      .all(args.path) as ArtifactRow[];
  } else if (args.episode_spec_id) {
    rows = db
      .prepare(
        `SELECT id, episode_spec_id, kind, path, digest, created_at
           FROM saga3_artifacts
          WHERE episode_spec_id = ?
          ORDER BY created_at ASC`,
      )
      .all(args.episode_spec_id) as ArtifactRow[];
  } else {
    throw new Error('saga3_read_artifacts requires episode_spec_id or path.');
  }
  return { artifacts: rows };
}

interface ReadConditionsInput {
  episode_spec_id: string;
}

interface ConditionRow {
  episode_spec_id: string;
  condition_type: string;
  obligation_id: string;
  scope_type: string;
  scope_id: string;
  status: string;
}

function handleReadConditions(
  args: ReadConditionsInput,
): { conditions: Array<{ conditionType: string; status: string; obligationId: string }> } {
  const rows = db
    .prepare(
      `SELECT episode_spec_id, condition_type, obligation_id, scope_type, scope_id, status
         FROM saga3_condition_instances
        WHERE episode_spec_id = ?
        ORDER BY condition_type ASC`,
    )
    .all(args.episode_spec_id) as ConditionRow[];
  return {
    conditions: rows.map((r) => ({
      conditionType: r.condition_type,
      status: r.status,
      obligationId: r.obligation_id,
    })),
  };
}

interface CompleteInput {
  episode_spec_id: string;
  condition_type: string;
  result: 'completed' | 'failed';
}

function handleComplete(args: CompleteInput): { ok: true; new_status: string } {
  assertEpisodeScope(args.episode_spec_id);
  assertConditionScope(args.condition_type);
  const prov = episodeProvenance(args.episode_spec_id);
  const latest = db
    .prepare(
      `SELECT verdict, generation, source_fingerprint, environment_fingerprint
         FROM saga3_evidence_records
        WHERE episode_spec_id = ? AND condition_type = ?
        ORDER BY observed_at DESC
        LIMIT 1`,
    )
    .get(args.episode_spec_id, args.condition_type) as {
      verdict: string;
      generation: number;
      source_fingerprint: string;
      environment_fingerprint: string;
    } | undefined;

  const current = latest?.generation === prov.generation
    && latest?.source_fingerprint === prov.sourceFingerprint;
  let newStatus = 'Unknown';
  if (current && latest?.verdict === 'passed') {
    newStatus = 'True';
  } else if (current && latest?.verdict === 'failed') {
    newStatus = 'False';
  }

  const result = db
    .prepare(
      `UPDATE saga3_condition_instances
          SET status = ?, observed_generation = ?, source_fingerprint = ?,
              environment_fingerprint = ?, projection_version = projection_version + 1,
              last_transition_at = datetime('now'), updated_at = datetime('now')
        WHERE episode_spec_id = ? AND condition_type = ?`,
    )
    .run(newStatus, current ? prov.generation : null,
      current ? prov.sourceFingerprint : null,
      current ? prov.environmentFingerprint : null,
      args.episode_spec_id, args.condition_type);

  if (result.changes === 0) {
    throw new Error(
      `Condition not found for episode ${args.episode_spec_id}: ${args.condition_type}`,
    );
  }

  return { ok: true, new_status: newStatus };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: 'saga3_propose_artifact',
    description:
      'Propose (write) an artifact for a saga3 episode: writes content to disk at path (relative to the workspace root) and inserts a row into the saga3 artifact manifest. Returns the new artifact id.',
    annotations: { title: 'Saga3: Propose Artifact', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string', description: 'The episode spec this artifact belongs to.' },
        kind: { type: 'string', description: "Artifact kind (e.g. 'prd', 'uc', 'code', 'test')." },
        path: { type: 'string', description: 'Path relative to the workspace root where content is written.' },
        content: { type: 'string', description: 'The artifact content to write to disk.' },
        digest: { type: 'string', description: 'Optional sha256 of content. Computed from content if omitted.' },
      },
      required: ['episode_spec_id', 'kind', 'path', 'content'],
    },
  },
  {
    name: 'saga3_propose_verification',
    description:
      'Propose verification evidence for a saga3 condition. Inserts into the saga3 evidence store with provenance (generation, source/environment fingerprint) filled from the frozen episode spec. The worker supplies only the oracle identity, verdict, and raw output; the server attaches provenance.',
    annotations: { title: 'Saga3: Propose Verification', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string', description: 'The episode spec this evidence belongs to.' },
        condition_type: { type: 'string', description: 'The condition this evidence bears on (e.g. ImplementationComplete).' },
        oracle_id: { type: 'string', description: 'Identity of the oracle that produced the observation.' },
        oracle_version: { type: 'string', description: 'Version of the oracle.' },
        verdict: { type: 'string', enum: ['passed', 'failed', 'unknown', 'error'], description: 'The oracle verdict.' },
        stdout: { type: 'string', description: 'Raw oracle output (hashed into raw_digest).' },
        exit_code: { type: 'integer', description: 'Oracle process exit code.' },
      },
      required: ['episode_spec_id', 'condition_type', 'oracle_id', 'oracle_version', 'verdict', 'stdout', 'exit_code'],
    },
  },
  {
    name: 'saga3_read_artifacts',
    description:
      'Read saga3 artifact manifest rows. Filter by episode_spec_id to list all artifacts for an episode, or by path to fetch a specific artifact. Returns the manifest rows (path, digest, kind).',
    annotations: { title: 'Saga3: Read Artifacts', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string', description: 'Episode spec id to list artifacts for.' },
        path: { type: 'string', description: 'Specific artifact path to look up.' },
      },
    },
  },
  {
    name: 'saga3_read_conditions',
    description:
      'Read the saga3 condition board for an episode. Returns the current status and obligation id of every condition instance for the given episode spec.',
    annotations: { title: 'Saga3: Read Conditions', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string', description: 'Episode spec id to read conditions for.' },
      },
      required: ['episode_spec_id'],
    },
  },
  {
    name: 'saga3_complete',
    description:
      'Close a saga3 worker attempt. The controller derives status only from current attached evidence: passed -> True, failed -> False, missing/inconclusive/stale -> Unknown. The declared result never substitutes for evidence.',
    annotations: { title: 'Saga3: Complete Condition', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        episode_spec_id: { type: 'string', description: 'Episode spec id of the condition.' },
        condition_type: { type: 'string', description: 'The condition type to transition.' },
        result: { type: 'string', enum: ['completed', 'failed'], description: 'Worker-declared attempt outcome for diagnostics; condition authority remains evidence-only.' },
      },
      required: ['episode_spec_id', 'condition_type', 'result'],
    },
  },
];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function friendlyError(msg: string): string {
  if (msg.includes('UNIQUE constraint failed')) {
    return 'A record with that value already exists.';
  }
  if (msg.includes('NOT NULL constraint failed')) {
    return 'A required field is missing.';
  }
  if (msg.includes('FOREIGN KEY constraint failed')) {
    return 'Referenced record not found.';
  }
  if (msg.includes('no such table')) {
    return 'saga3 schema not initialized.';
  }
  return msg;
}

interface ToolHandlerEntry {
  readonly handler: (args: Record<string, unknown>) => unknown;
  readonly required: readonly string[];
}

const HANDLERS: Record<string, ToolHandlerEntry> = {
  saga3_propose_artifact: {
    handler: (a) => handleProposeArtifact(a as unknown as ProposeArtifactInput),
    required: ['episode_spec_id', 'kind', 'path', 'content'],
  },
  saga3_propose_verification: {
    handler: (a) => handleProposeVerification(a as unknown as ProposeVerificationInput),
    required: ['episode_spec_id', 'condition_type', 'oracle_id', 'oracle_version', 'verdict', 'stdout', 'exit_code'],
  },
  saga3_read_artifacts: {
    handler: (a) => handleReadArtifacts(a as unknown as ReadArtifactsInput),
    required: [],
  },
  saga3_read_conditions: {
    handler: (a) => handleReadConditions(a as unknown as ReadConditionsInput),
    required: ['episode_spec_id'],
  },
  saga3_complete: {
    handler: (a) => handleComplete(a as unknown as CompleteInput),
    required: ['episode_spec_id', 'condition_type', 'result'],
  },
};

/**
 * Start the saga3 MCP server on stdio. Opens (and bootstraps) the DB, wires
 * the tool handlers, and connects the StdioServerTransport. Resolves once the
 * transport is connected. The server runs until the process is signaled.
 */
export async function startSaga3McpServer(): Promise<void> {
  db = openDb();

  const server = new Server(
    { name: 'saga3', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      const entry = HANDLERS[name];
      if (!entry) {
        throw new Error(`Unknown tool: ${name}`);
      }

      const input = args ?? {};
      const missing = entry.required.filter((k) => input[k] === undefined || input[k] === null);
      if (missing.length > 0) {
        throw new Error(`Missing required field(s): ${missing.join(', ')}`);
      }

      const result = entry.handler(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Error: ${friendlyError(msg)}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Saga3 MCP Server running on stdio');
}

// ---------------------------------------------------------------------------
// Entry point — run when invoked directly (node dist/saga3/app/mcp-server.js)
// ---------------------------------------------------------------------------

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

if (isMainModule()) {
  startSaga3McpServer().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
