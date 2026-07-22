/**
 * Saga 3 — Worker prompt + MCP config builder.
 *
 * Constructs the system prompt handed to a claude worker process and the
 * --mcp-config JSON that injects the saga3 MCP server (the only tools the
 * worker is allowed to call).
 *
 * This is the saga3 analogue of tracker-view/claude-runner.mjs buildPrompt /
 * writeMcpConfig, but reshaped around the saga3 protocol: a worker satisfies
 * exactly one ConditionInstance (conditionType + obligationId) inside a frozen
 * episode, and reports back through the saga3_* MCP tools instead of the v2
 * worker_done / task_update tools.
 *
 * Key differences from the v2 prompt:
 *  - The unit of work is a condition, not a task. The worker never sees a task
 *    row; it sees (episodeSpecId, generation, conditionType, obligationId).
 *  - The only permitted tools are the saga3_* MCP tools. Calling any v2 tool
 *    (worker_done, task_update, worker_next, ...) is a protocol violation.
 *  - The worker registers its own output via saga3_propose_artifact /
 *    saga3_propose_verification, then signals completion via saga3_complete.
 */

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Input for {@link buildWorkerPrompt}. Every field is required: a saga3 worker
 * is launched for exactly one condition and must know its full scope.
 */
export interface WorkerPromptInput {
  /** ConditionType of the ConditionInstance being addressed (e.g. ImplementationComplete). */
  readonly conditionType: string;
  /** Obligation id scoped to the condition. */
  readonly obligationId: string;
  /** Saga skill id whose SKILL.md the worker must follow (e.g. saga-worker). */
  readonly skillId: string;
  /** Absolute path to the workspace the worker writes artifacts into. */
  readonly workspaceRoot: string;
  /** Frozen episode spec id the condition belongs to. */
  readonly episodeSpecId: string;
  /** Episode generation number (CAS fence against superseded episodes). */
  readonly generation: number;
  /** Worker role derived from the skill (developer, verifier, ...). */
  readonly role: string;
  readonly oracleId?: string;
}

/**
 * Build the system prompt for one saga3 worker launch.
 *
 * The prompt follows the same shape as the v2 claude-runner buildPrompt — a
 * short identity line, a block of `key=value` scoping fields, then numbered
 * hard rules — but rewrites the rules around the saga3 condition protocol.
 */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  return [
    'You are a Saga 3 worker. Saga assigned you one condition to satisfy.',
    '',
    `episode_spec_id=${input.episodeSpecId}`,
    `generation=${input.generation}`,
    `condition=${input.conditionType}`,
    `obligation=${input.obligationId}`,
    `workspace_root=${input.workspaceRoot}`,
    `role=${input.role}`,
    `required_oracle=${input.oracleId ?? 'condition-oracle'}`,
    '',
    'INSTRUCTIONS:',
    `1. Read your skill at skills/${input.skillId}/SKILL.md for how to do this work.`,
    '2. Do the work according to the skill (create files, write artifacts, run checks).',
    '3. When done, create your artifact files in the workspace.',
    '4. Report your result by calling the saga3 MCP tools available to you:',
    '   - saga3_propose_artifact: to register an artifact you created',
    '   - saga3_propose_verification: REQUIRED for every condition; use required_oracle exactly and report passed only after checking the produced result',
    '   - saga3_complete: to signal you are done with this condition',
    '5. Do NOT call worker_done, task_update, or any v2 tool. Use only saga3_* tools.',
    '6. saga3_complete cannot make a condition True without current passed verification evidence.',
    '7. After saga3_complete, stop. Do not start another task.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// MCP config
// ---------------------------------------------------------------------------

/**
 * Shape of the --mcp-config JSON handed to the claude CLI. Only the saga3
 * server is exposed; v2 tools are not registered, so the worker cannot call
 * them even by mistake.
 */
export interface McpConfig {
  readonly mcpServers: {
    readonly saga3: {
      readonly type: 'stdio';
      readonly command: 'node';
      readonly args: readonly [string, ...string[]];
      readonly env: {
        readonly DB_PATH: string;
        readonly SAGA3_EPISODE_SPEC_ID: string;
      };
    };
  };
}

/**
 * Build the --mcp-config JSON object for one worker launch.
 *
 * `saga3ServerPath` is the absolute path to the compiled saga3 MCP server
 * entry (e.g. dist/saga3/mcp/server.js). The env values are read from
 * process.env at call time, matching the codebase convention (DB_PATH in
 * src/db.ts, src/saga3/app/cli.ts):
 *   - DB_PATH                 — saga SQLite database (required)
 *   - SAGA3_EPISODE_SPEC_ID   — frozen episode the worker is scoped to
 *
 * Throws if either env value is missing: launching a worker without a DB or
 * episode scope would produce a server that cannot answer any saga3_* call.
 */
export function buildMcpConfig(saga3ServerPath: string): McpConfig {
  const dbPath = process.env.DB_PATH;
  const episodeSpecId = process.env.SAGA3_EPISODE_SPEC_ID;

  if (!dbPath) {
    throw new Error(
      'buildMcpConfig: process.env.DB_PATH is required (path to the saga SQLite database).',
    );
  }
  if (!episodeSpecId) {
    throw new Error(
      'buildMcpConfig: process.env.SAGA3_EPISODE_SPEC_ID is required (the frozen episode the worker is scoped to).',
    );
  }

  return {
    mcpServers: {
      saga3: {
        type: 'stdio',
        command: 'node',
        args: [saga3ServerPath],
        env: {
          DB_PATH: dbPath,
          SAGA3_EPISODE_SPEC_ID: episodeSpecId,
        },
      },
    },
  };
}
