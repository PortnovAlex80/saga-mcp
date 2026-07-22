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
    'INSTRUCTIONS:',
    `1. Read and follow ${skillPath}.`,
    '2. Perform only the assigned semantic work. Do not select another condition.',
    '3. For every artifact to be accepted, call saga3_propose_artifact with its complete content.',
    '4. Call saga3_propose_verification with the exact command Saga should execute.',
    '   Use required_oracle and required_oracle_version exactly.',
    '   Do not claim that the command passed. Your output is a procedure proposal, not evidence.',
    '5. Call saga3_complete only after all artifact and verification proposals are submitted.',
    '6. Saga 3 will validate your assignment, apply accepted artifacts, execute the oracle itself,',
    '   attach provenance, and derive the condition state from the real observation.',
    '7. Do not call worker_done, task_update, worker_next, or any non-saga3 control tool.',
    '8. After saga3_complete returns, stop.',
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
