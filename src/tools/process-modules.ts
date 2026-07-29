import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { ProcessModuleRegistry } from '../process-modules/application/process-module-registry.js';
import { validateLifecycleDefinition } from '../process-modules/application/lifecycle-router.js';
import { validateProcessModuleDefinition } from '../process-modules/application/validate-process-module.js';
import { productDeliveryLifecycle } from '../process-modules/lifecycles/product-delivery-lifecycle.js';
import { discoveryProcessModule } from '../process-modules/modules/discovery/discovery-process-module.js';
import { formalizationProcessModule } from '../process-modules/modules/formalization/formalization-process-module.js';
import { developmentProcessModule } from '../process-modules/modules/development/development-process-module.js';
import { deliveryProcessModule } from '../process-modules/modules/delivery/delivery-process-module.js';
import {
  processModuleKey,
  type ProcessModuleReference,
} from '../process-modules/domain/process-module.js';
import type {
  ExecutorKind,
  ProcessModuleCertificateRef,
  ProcessModuleInput,
  ProcessModuleOutput,
} from '../process-modules/persistence/process-run.js';
import type { ProcessRunStatus } from '../process-modules/persistence/process-run.js';
import {
  isTerminalStatus,
} from '../process-modules/persistence/process-run-repository.js';
import {
  SqliteProcessRunRepository,
} from '../process-modules/persistence/sqlite-process-run-repository.js';
import type { ToolHandler } from '../types.js';

// Two namespaces live side by side under the same MCP gateway:
//
//   process_module_*  — read-only Process Module CATALOG tools. List/get/
//                       validate the registered module definitions. These
//                       never touch ProcessRun persistence.
//   process_run_*     — ProcessRun LIFECYCLE tools. Start/read/list/set/
//                       cancel one execution envelope. These are the generic
//                       Process Module runtime surface shared by every module
//                       (discovery, formalization, future artifact-review).
//
// The split keeps the catalog (declarative, immutable) separate from runs
// (mutable, idempotent, write-once terminal) and avoids name collisions in
// the flat MCP tool namespace.

// Wave 13 removed modules/catalog.ts; the catalog is built inline from the
// production module definitions imported directly above.
const registry = new ProcessModuleRegistry();
registry.register(discoveryProcessModule);
registry.register(formalizationProcessModule);
registry.register(developmentProcessModule);
registry.register(deliveryProcessModule);

// P0: repository is constructed lazily so the schema is created only when a
// ProcessRun tool is actually invoked. This keeps the catalog/validation tools
// (which never touch ProcessRun persistence) cheap and side-effect-free.
let repository: SqliteProcessRunRepository | null = null;
function repo(): SqliteProcessRunRepository {
  if (!repository) repository = new SqliteProcessRunRepository();
  return repository;
}

/**
 * Reset the cached repository. Production never calls this — the singleton
 * lives for the MCP server's lifetime. Tests that swap process.env.DB_PATH
 * between cases call it (after closeDb) so the next repo() re-resolves the
 * underlying DB handle.
 */
export function _resetProcessRunRepositoryForTests(): void {
  repository = null;
}

function requiredString(args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required (non-empty string)`);
  }
  return value;
}

function requiredNumber(args: Record<string, unknown>, field: string): number {
  const value = args[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${field} is required (integer)`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, field: string): number | null {
  const value = args[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer when provided`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// CATALOG (read-only): process_module_list / process_module_get / process_module_validate
// ---------------------------------------------------------------------------

function handleProcessModuleList() {
  const modules = registry.list().map(module => {
    const validation = validateProcessModuleDefinition(module);
    return {
      identity: module.identity,
      input_schema: module.inputContract.id,
      output_schema: module.outputContract.id,
      outcomes: module.outcomes.map(outcome => outcome.code),
      node_count: module.flow.nodes.length,
      lm_node_count: module.flow.nodes.filter(node => node.kind === 'lm').length,
      execution_profile_count: module.executionProfiles.length,
      valid: validation.valid,
      validation_errors: validation.errors,
      validation_warnings: validation.warnings,
    };
  });
  return { modules, count: modules.length };
}

function handleProcessModuleGet(args: Record<string, unknown>) {
  const name = requiredString(args, 'name');
  const version = requiredString(args, 'version');
  const module = registry.require({ name, version });
  return {
    module,
    validation: validateProcessModuleDefinition(module),
  };
}

function handleProcessModuleValidate(args: Record<string, unknown>) {
  const name = requiredString(args, 'name');
  const version = requiredString(args, 'version');
  const module = registry.require({ name, version });
  return {
    module_ref: `${name}@${version}`,
    ...validateProcessModuleDefinition(module),
  };
}

function handleProcessLifecycleGet() {
  return {
    lifecycle: productDeliveryLifecycle,
    validation: validateLifecycleDefinition(productDeliveryLifecycle, registry),
  };
}

// ---------------------------------------------------------------------------
// ProcessRun lifecycle tools (process_run_*).
//
// These tools are intentionally NARROW in P0: they persist a ProcessRun record
// and transition its status, but do NOT invoke any executor yet. Real executor
// wiring lands in P1 (ProcessModuleExecutor interface) + P5
// (LegacyFormalizationProcessAdapter). The orchestrate-cli engine remains the
// entry point that actually runs the module's workers; these MCP tools expose
// the generic ProcessRun envelope for operators and tests.
//
// NOTE: pause/resume are NOT in P0. They depend on executor capabilities
// (P1) — a status value the executor must observe to halt/resume work. Adding
// them now would let callers set a status no executor can honour. process_run_set
// remains the universal transition primitive; dedicated pause/resume tools
// return in P1 once capabilities exist.
// ---------------------------------------------------------------------------

function parseModuleRef(args: Record<string, unknown>): ProcessModuleReference {
  const name = requiredString(args, 'module_name');
  const version = requiredString(args, 'module_version');
  // Verify the module is registered before creating a ProcessRun — an unknown
  // module reference would otherwise create an orphan row that no executor
  // could ever pick up.
  registry.require({ name, version });
  return { name, version };
}

function parseExecutorKind(args: Record<string, unknown>): ExecutorKind {
  const raw = requiredString(args, 'executor_kind');
  const allowed: readonly ExecutorKind[] = ['legacy-adapter', 'generic-flow', 'external', 'human'];
  if (!allowed.includes(raw as ExecutorKind)) {
    throw new Error(
      `executor_kind '${raw}' is invalid; expected one of [${allowed.join(', ')}]`,
    );
  }
  return raw as ExecutorKind;
}

function parseInput(args: Record<string, unknown>): ProcessModuleInput {
  const schema = requiredString(args, 'input_schema');
  const payload = args.input_payload;
  if (payload === undefined || payload === null) {
    throw new Error('input_payload is required');
  }
  const contentHash = requiredString(args, 'input_hash');
  return { schema, payload, contentHash };
}

function handleProcessRunStart(args: Record<string, unknown>) {
  const moduleRef = parseModuleRef(args);
  const executorKind = parseExecutorKind(args);
  const input = parseInput(args);
  const projectId = requiredNumber(args, 'project_id');
  const epicId = optionalNumber(args, 'epic_id');
  const initiatedBy = requiredString(args, 'initiated_by');
  const idempotencyKey = requiredString(args, 'idempotency_key');
  const projectedStageRaw = args.projected_stage;
  let projectedStage: string | null = null;
  if (projectedStageRaw !== undefined && projectedStageRaw !== null) {
    if (typeof projectedStageRaw !== 'string') {
      throw new Error('projected_stage must be a string when provided');
    }
    projectedStage = projectedStageRaw;
  }
  // Wave 2 installation pin (W3-A3, spec §6). Both optional: omitted → null
  // (legacy run). When both are supplied the run is pinned to the immutable
  // module installation; the executor resolves package resources via the
  // Wave 2 PackageRegistry instead of the built-in catalog.
  const installationIdRaw = args.installation_id;
  let installationId: number | null = null;
  if (installationIdRaw !== undefined && installationIdRaw !== null) {
    if (typeof installationIdRaw !== 'number' || !Number.isInteger(installationIdRaw)) {
      throw new Error('installation_id must be an integer when provided');
    }
    installationId = installationIdRaw;
  }
  const packageDigestRaw = args.package_digest;
  let packageDigest: string | null = null;
  if (packageDigestRaw !== undefined && packageDigestRaw !== null) {
    if (typeof packageDigestRaw !== 'string') {
      throw new Error('package_digest must be a string when provided');
    }
    packageDigest = packageDigestRaw;
  }
  const result = repo().start({
    moduleRef,
    executorKind,
    input,
    projectedStage,
    installationId,
    packageDigest,
    invocationContext: { projectId, epicId, initiatedBy, idempotencyKey },
  });
  return {
    process_run_id: result.record.id,
    module_ref_key: result.record.moduleRefKey,
    status: result.record.status,
    replayed: result.replayed,
    record: result.record,
  };
}

function handleProcessRunGet(args: Record<string, unknown>) {
  // Two read shapes: by id, or by (project_id, module_name, module_version,
  // idempotency_key). If both are provided, id wins.
  if (args.process_run_id !== undefined) {
    const id = requiredNumber(args, 'process_run_id');
    const record = repo().read(id);
    if (!record) throw new Error(`process_run ${id} not found`);
    return { record };
  }
  const projectId = requiredNumber(args, 'project_id');
  const moduleRef = parseModuleRef(args);
  const idempotencyKey = requiredString(args, 'idempotency_key');
  const record = repo().readByIdempotencyKey(
    projectId, processModuleKey(moduleRef), idempotencyKey,
  );
  if (!record) throw new Error('process_run not found for the given idempotency key');
  return { record };
}

function handleProcessRunList(args: Record<string, unknown>) {
  const projectId = requiredNumber(args, 'project_id');
  const epicId = optionalNumber(args, 'epic_id');
  const records = repo().list(projectId, epicId);
  return { runs: records, count: records.length };
}

interface StatusUpdateArgs {
  status?: ProcessRunStatus;
  localOutcome?: string | null;
  output?: ProcessModuleOutput | null;
  certificate?: ProcessModuleCertificateRef | null;
  executorRunRef?: string | null;
  error?: string | null;
}

function parseStatusUpdate(args: Record<string, unknown>): StatusUpdateArgs {
  const update: StatusUpdateArgs = {};
  if (args.status !== undefined) {
    const raw = requiredString(args, 'status');
    const allowed = [
      'created', 'preparing', 'running', 'paused', 'settling',
      'completed', 'failed', 'cancelled',
    ] as const;
    if (!allowed.includes(raw as typeof allowed[number])) {
      throw new Error(`status '${raw}' is invalid; expected one of [${allowed.join(', ')}]`);
    }
    update.status = raw as typeof allowed[number];
  }
  if (args.local_outcome !== undefined) {
    const raw = args.local_outcome;
    if (raw !== null && typeof raw !== 'string') {
      throw new Error('local_outcome must be a string or null');
    }
    update.localOutcome = raw as string | null;
  }
  if (args.output !== undefined) {
    const raw = args.output;
    if (raw === null) {
      update.output = null;
    } else if (typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      update.output = {
        schema: requiredString(o, 'schema'),
        artifactRef: requiredString(o, 'artifact_ref'),
        contentHash: requiredString(o, 'content_hash'),
      };
    } else {
      throw new Error('output must be an object or null');
    }
  }
  if (args.certificate !== undefined) {
    const raw = args.certificate;
    if (raw === null) {
      update.certificate = null;
    } else if (typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      update.certificate = {
        schema: requiredString(o, 'schema'),
        certificateRef: requiredString(o, 'certificate_ref'),
        certificateHash: requiredString(o, 'certificate_hash'),
      };
    } else {
      throw new Error('certificate must be an object or null');
    }
  }
  if (args.executor_run_ref !== undefined) {
    const raw = args.executor_run_ref;
    if (raw !== null && typeof raw !== 'string') {
      throw new Error('executor_run_ref must be a string or null');
    }
    update.executorRunRef = raw as string | null;
  }
  if (args.error !== undefined) {
    const raw = args.error;
    if (raw !== null && typeof raw !== 'string') {
      throw new Error('error must be a string or null');
    }
    update.error = raw as string | null;
  }
  return update;
}

/**
 * Universal status transition primitive for one ProcessRun. Validates the
 * transition against ALLOWED_TRANSITIONS and enforces write-once on
 * outcome/output/certificate for terminal rows. This is the only mutation
 * surface for ProcessRun in P0 — start, then drive created→preparing→running
 * →settling→completed (or →failed/→cancelled). Dedicated pause/resume tools
 * return in P1 once the executor capability surface exists; until then
 * process_run_set is the universal primitive.
 */
function handleProcessRunSet(args: Record<string, unknown>) {
  const id = requiredNumber(args, 'process_run_id');
  const update = parseStatusUpdate(args);
  const record = repo().update(id, update);
  return { record };
}

/**
 * Cancel one ProcessRun. Terminal — no further transitions. Executor-side
 * cleanup (stopping workers, releasing locks) is the executor's responsibility.
 */
function handleProcessRunCancel(args: Record<string, unknown>) {
  const id = requiredNumber(args, 'process_run_id');
  const reason = args.reason;
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    throw new Error('reason must be a string when provided');
  }
  const current = repo().read(id);
  if (!current) throw new Error(`process_run ${id} not found`);
  if (isTerminalStatus(current.status)) {
    // Already terminal — return as-is, no-op.
    return { record: current, already_terminal: true };
  }
  return {
    record: repo().update(id, {
      status: 'cancelled',
      error: (reason as string | null) ?? null,
    }),
  };
}

export const definitions: Tool[] = [
  // --- Catalog (read-only) -------------------------------------------------
  {
    name: 'process_module_list',
    description:
      'List registered Saga Process Modules with their versioned identity, contracts, local outcomes, Flow size and deterministic validation status. Read-only. Use this before designing a new module to inspect the installed module catalog.',
    annotations: {
      title: 'Process Module: List',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'process_module_get',
    description:
      'Read one registered Process Module definition by exact name and semantic version. Returns contracts, outcomes, Flow, artifacts, policies, invariants, execution profiles and validation result. Read-only.',
    annotations: {
      title: 'Process Module: Get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact module name, for example product-discovery.' },
        version: { type: 'string', description: 'Exact semantic version, for example 3.0.0.' },
      },
      required: ['name', 'version'],
    },
  },
  {
    name: 'process_module_validate',
    description:
      'Run deterministic structural validation for one registered Process Module. Checks identity/version, outcomes, Flow reachability, terminal nodes, execution profiles, tracker/checklist declarations, policies, invariants and artifact uniqueness. Read-only.',
    annotations: {
      title: 'Process Module: Validate',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact registered module name.' },
        version: { type: 'string', description: 'Exact registered module version.' },
      },
      required: ['name', 'version'],
    },
  },
  {
    name: 'process_lifecycle_get',
    description:
      'Read and validate the complete built-in Product Delivery Lifecycle: Discovery, Formalization, Development and Delivery/Release. Shows Stage Bindings, exact handoff mappings and local-outcome routes. Read-only.',
    annotations: {
      title: 'Process Lifecycle: Get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },

  // --- ProcessRun lifecycle (generic Process Module runtime surface) -------
  {
    name: 'process_run_start',
    description:
      'Start (or replay) one ProcessRun for a registered Process Module. Idempotent on (project_id, module_name, module_version, idempotency_key): a second call with the same key + same input_hash returns the existing run with replayed=true. Reusing the same key with a DIFFERENT input_hash throws IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT. P0 persists the run record; executor wiring (legacy-adapter/generic-flow/external/human) is invoked by the orchestrate-cli engine, not by this tool.',
    annotations: {
      title: 'Process Run: Start',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        module_name: { type: 'string', description: 'Registered module name, e.g. product-discovery.' },
        module_version: { type: 'string', description: 'Registered module version, e.g. 3.0.0.' },
        executor_kind: {
          type: 'string',
          enum: ['legacy-adapter', 'generic-flow', 'external', 'human'],
          description: 'How the module will be executed. legacy-adapter wraps an existing engine; generic-flow runs universal LM/kernel nodes; external delegates to another system; human requires explicit human authority.',
        },
        input_schema: { type: 'string', description: 'Module input contract id, e.g. saga3.discovery-case.v1.' },
        input_payload: { description: 'Module input payload. The persistence layer stores its canonical JSON; the executor decodes it against input_schema.' },
        input_hash: {
          type: 'string',
          description: 'SHA-256 over the canonical JSON of input_payload. Caller computes; persistence trusts the caller.',
        },
        project_id: { type: 'integer', minimum: 1 },
        epic_id: { type: 'integer', minimum: 1, description: 'Optional. Null = project-wide run.' },
        initiated_by: { type: 'string', description: 'Caller identity (operator, orchestrator, agent id).' },
        idempotency_key: {
          type: 'string',
          description: 'Caller-supplied key. Unique within (project_id, module_name, module_version). Same key + same input_hash = replay; same key + different input_hash = error.',
        },
        projected_stage: {
          type: 'string',
          description: 'Optional. Legacy episode_workflows.stage to project when this run completes (e.g. "discovery", "formalization"). Null = no projection.',
        },
      },
      required: [
        'module_name', 'module_version', 'executor_kind',
        'input_schema', 'input_payload', 'input_hash',
        'project_id', 'initiated_by', 'idempotency_key',
      ],
    },
  },
  {
    name: 'process_run_get',
    description:
      'Read one ProcessRun by id, or by (project_id, module_name, module_version, idempotency_key). Read-only.',
    annotations: {
      title: 'Process Run: Get',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        process_run_id: { type: 'integer', minimum: 1, description: 'Read by id. Wins if provided.' },
        project_id: { type: 'integer', minimum: 1, description: 'Required when reading by idempotency key.' },
        module_name: { type: 'string' },
        module_version: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
    },
  },
  {
    name: 'process_run_list',
    description:
      'List ProcessRuns for one project, optionally narrowed to one epic. Ordered by id DESC. Read-only.',
    annotations: {
      title: 'Process Run: List',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', minimum: 1 },
        epic_id: { type: 'integer', minimum: 1, description: 'Optional. Null = all project runs.' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'process_run_set',
    description:
      'Universal status transition primitive for one ProcessRun. Validates the transition against ALLOWED_TRANSITIONS and enforces write-once on outcome/output/certificate for terminal rows. Orchestrators use it for preparing→running→settling→completed (or →failed/→cancelled). pause/resume are not exposed in P0 — they return in P1 once executor capabilities exist.',
    annotations: {
      title: 'Process Run: Set Status',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        process_run_id: { type: 'integer', minimum: 1 },
        status: {
          type: 'string',
          enum: ['created', 'preparing', 'running', 'paused', 'settling', 'completed', 'failed', 'cancelled'],
        },
        local_outcome: { type: 'string', description: 'Module-local outcome. Write-once on terminal rows.' },
        output: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
            artifact_ref: { type: 'string' },
            content_hash: { type: 'string' },
          },
          required: ['schema', 'artifact_ref', 'content_hash'],
        },
        certificate: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
            certificate_ref: { type: 'string' },
            certificate_hash: { type: 'string' },
          },
          required: ['schema', 'certificate_ref', 'certificate_hash'],
        },
        executor_run_ref: { type: 'string' },
        error: { type: 'string' },
      },
      required: ['process_run_id'],
    },
  },
  {
    name: 'process_run_cancel',
    description:
      'Cancel one ProcessRun. Terminal — no further transitions allowed. Records the optional reason in the error field. Idempotent on already-terminal rows (returns the unchanged record with already_terminal=true).',
    annotations: {
      title: 'Process Run: Cancel',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        process_run_id: { type: 'integer', minimum: 1 },
        reason: { type: 'string' },
      },
      required: ['process_run_id'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  // Catalog
  process_module_list: handleProcessModuleList,
  process_module_get: handleProcessModuleGet,
  process_module_validate: handleProcessModuleValidate,
  process_lifecycle_get: handleProcessLifecycleGet,
  // ProcessRun lifecycle
  process_run_start: handleProcessRunStart,
  process_run_get: handleProcessRunGet,
  process_run_list: handleProcessRunList,
  process_run_set: handleProcessRunSet,
  process_run_cancel: handleProcessRunCancel,
};
