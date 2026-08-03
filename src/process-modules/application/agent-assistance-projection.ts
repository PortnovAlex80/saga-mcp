/**
 * Execution-scoped projection of package-owned assistance.
 *
 * This is the bootstrap projection used before the durable inner
 * NodeProtocol cursor is connected to the worker driver. It is deliberately
 * node-scoped: the tracker remains the exact inner-step program counter.
 * The generic hook selects an event from this projection without knowing the
 * module or node vocabulary.
 */

import type {
  AgentAssistanceDefinition,
  AssistanceBlock,
  AssistanceEvent,
} from '../domain/spi/agent-assistance.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';

export const AGENT_ASSISTANCE_PROJECTION_SCHEMA =
  'saga3.agent-assistance-projection.v1' as const;

export interface AgentAssistanceProjectionScope {
  readonly processRunId: number | null;
  readonly nodeId: string;
  readonly attempt: number;
}

export interface AgentAssistanceProjection {
  readonly schemaVersion: typeof AGENT_ASSISTANCE_PROJECTION_SCHEMA;
  readonly executionId: string | null;
  readonly executionScope: AgentAssistanceProjectionScope;
  readonly stateVersion: string;
  readonly mode: AgentAssistanceDefinition['mode'];
  readonly budgets: AgentAssistanceDefinition['budgets'];
  readonly events: readonly AssistanceEvent[];
}

export interface RenderAgentAssistanceProjectionRequest {
  readonly definition: AgentAssistanceDefinition;
  readonly executionId: string | null;
  readonly processRunId: number | null;
  readonly nodeId: string;
  readonly attempt: number;
  readonly bindings: Readonly<Record<string, string>>;
}

function hydrateText(
  source: string,
  bindings: Readonly<Record<string, string>>,
): string {
  let hydrated = source;
  for (const [key, value] of Object.entries(bindings)) {
    hydrated = hydrated.replaceAll(`{${key}}`, value);
  }
  const unresolved = hydrated.match(/\{[A-Z][A-Z0-9_]*\}/g);
  if (unresolved) {
    throw new Error(
      `AGENT_ASSISTANCE_BINDING_MISSING: unresolved ${[...new Set(unresolved)].join(', ')}`,
    );
  }
  return hydrated;
}

function hydrateBlock(
  block: AssistanceBlock,
  bindings: Readonly<Record<string, string>>,
): AssistanceBlock {
  return {
    kind: block.kind,
    content: hydrateText(block.content, bindings),
  };
}

/**
 * Render a deterministic, bounded package definition for one worker
 * execution. The hook performs the final character cap; package token/count
 * budgets remain attached for observability and future ProtocolRun cutover.
 */
export function renderAgentAssistanceProjection(
  request: RenderAgentAssistanceProjectionRequest,
): AgentAssistanceProjection {
  if (request.definition.nodeId !== request.nodeId) {
    throw new Error(
      `AGENT_ASSISTANCE_NODE_MISMATCH: definition '${request.definition.nodeId}' `
      + `cannot assist node '${request.nodeId}'`,
    );
  }
  if (!Number.isInteger(request.attempt) || request.attempt < 1) {
    throw new Error('AGENT_ASSISTANCE_ATTEMPT_INVALID');
  }

  const events = request.definition.events.map(event => ({
    event: event.event,
    blocks: event.blocks.map(block => hydrateBlock(block, request.bindings)),
  }));
  const executionScope: AgentAssistanceProjectionScope = {
    processRunId: request.processRunId,
    nodeId: request.nodeId,
    attempt: request.attempt,
  };
  const stateVersion = sha256Hex(canonicalJson({
    executionId: request.executionId,
    executionScope,
    mode: request.definition.mode,
    budgets: request.definition.budgets,
    events,
  }));

  return {
    schemaVersion: AGENT_ASSISTANCE_PROJECTION_SCHEMA,
    executionId: request.executionId,
    executionScope,
    stateVersion,
    mode: request.definition.mode,
    budgets: request.definition.budgets,
    events,
  };
}

export function serializeAgentAssistanceProjection(
  projection: AgentAssistanceProjection,
): string {
  return `${canonicalJson(projection)}\n`;
}
