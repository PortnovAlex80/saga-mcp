/**
 * Saga 3 worker prompt and MCP configuration.
 *
 * The worker receives one authorized condition assignment. It submits artifact
 * content and a verification procedure. It never submits authoritative
 * evidence or directly changes a condition.
 */

export interface WorkerPromptInput {
  readonly conditionType: string;
  readonly obligationId: string;
  readonly skillId: string;
  readonly workspaceRoot: string;
  readonly episodeSpecId: string;
  readonly generation: number;
  readonly role: string;
  readonly oracleId?: string;
  readonly skillsRoot: string;
}

export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const normalizedSkillsRoot = input.skillsRoot.replace(/\\/g, '/');
  const skillPath = `${normalizedSkillsRoot}/${input.skillId}/SKILL.md`;
  return [
    'You are a Saga 3 worker. Saga assigned you exactly one condition.',
    '',
    `episode_spec_id=${input.episodeSpecId}`,
    `generation=${input.generation}`,
    `condition=${input.conditionType}`,
    `obligation=${input.obligationId}`,
    `workspace_root=${input.workspaceRoot}`,
    `skills_root=${normalizedSkillsRoot}`,
    `role=${input.role}`,
    `required_oracle=${input.oracleId ?? 'condition-oracle'}`,
    'required_oracle_version=1',
    '',
    'HARD CONSTRAINTS (violating these is a protocol failure):',
    'A. Your session succeeds ONLY if you call saga3_propose_artifact at least once AND',
    '   saga3_propose_verification once AND saga3_complete once. Exiting without these three',
    '   calls is a failure, regardless of what you write in text. Narrating a plan is not work.',
    'B. Do NOT call the Skill tool. Do NOT delegate to an Agent. Do NOT use TaskCreate/TaskUpdate.',
    '   Do NOT explore the filesystem with ls/Bash/Glob. The skill content is already known to you',
    '   from the file path below — read it once with Read, then ACT.',
    'C. You have ONE job: produce the artifact content for this condition and submit it via MCP.',
    '   Write the content directly in the saga3_propose_artifact call. Do not write files via Bash',
    '   or Write — the MCP tool is the only accepted channel.',
    '',
    'INSTRUCTIONS:',
    `1. Read ${skillPath} once. This tells you what artifact to produce for ${input.conditionType}.`,
    '2. Produce the artifact content IN YOUR HEAD (it is a saga-kickstart brief / PRD / SRS / etc.).',
    `3. Call saga3_propose_artifact with episode_spec_id, kind, path, and the FULL content.`,
    `4. Call saga3_propose_verification with required_oracle=${input.oracleId ?? 'condition-oracle'},`,
    '   required_oracle_version=1, and a command that would verify the artifact (e.g. a lint/test/grep).',
    '   Do not claim it passed — Saga runs the command itself.',
    '5. Call saga3_complete with result=completed.',
    '6. Stop.',
    '',
    'Saga 3 validates your assignment, applies accepted artifacts, executes the oracle itself,',
    'attaches provenance, and derives the condition state from the real observation.',
    'Do not call worker_done, task_update, worker_next, or any non-saga3 control tool.',
  ].join('\n');
}

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

export function buildMcpConfig(saga3ServerPath: string): McpConfig {
  const dbPath = process.env.DB_PATH;
  const episodeSpecId = process.env.SAGA3_EPISODE_SPEC_ID;
  if (!dbPath) {
    throw new Error('buildMcpConfig: process.env.DB_PATH is required.');
  }
  if (!episodeSpecId) {
    throw new Error('buildMcpConfig: process.env.SAGA3_EPISODE_SPEC_ID is required.');
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
