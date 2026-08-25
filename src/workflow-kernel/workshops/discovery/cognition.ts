/**
 * workflow-kernel/workshops/discovery/cognition.ts - the cognition surface
 * of the Discovery workshop (WP-11D): envelope assembly, the scripted actor
 * and its deterministic channel.
 *
 * THE COGNITION PORT: the actor implements the WP-18 CognitionTransportContract
 * exactly like every other workshop - assemble from the SAME resolved role
 * contract, admit at the exact pre-send boundary through the SAME cumulative
 * accountant (the transport calls the bound AttemptAdmissionStore, which
 * lives in ./admission-store.ts), persist the SAME PromptAssemblyReceipt
 * shape. No second port, no opaque loop, no skip of ingress.
 *
 * STRUCTURAL LAW: this module imports NO persistence surface and executes
 * no SQL (the structural test enforces it). Every durable fact is committed
 * by the kernel repositories, never here.
 *
 * PURITY of assembly + actor: node:crypto digests + context-envelope types
 * + sibling manifest/products data. No clock, no randomness.
 */

import { createHash } from 'node:crypto';
import type { CanonicalRoleContract } from '../../domain/types.js';
import type { ContextEnvelope, EnvelopeLayer, ExternalReference, PromptAssemblyReceipt } from '../../context-envelope/receipt.js';
import type { CognitionTransportContract, ProviderChannelResult, ProviderNetworkChannel, TransportSendResult } from '../../context-envelope/transport.js';
import type { InstalledWorkshopManifest } from './installed-manifest.js';

/* ------------------------------------------------------------------ */
/* Envelope assembly (from the SAME resolved contract)                 */
/* ------------------------------------------------------------------ */

/** The bounded required-info manifest of a Discovery task. */
export interface RequiredIdeaInfo {
  /** The admitted idea product reference + summary. */
  readonly idea: readonly ExternalReference[];
  /** Discovery unknowns (D10: they never disappear at a boundary). */
  readonly unknowns: readonly ExternalReference[];
  /** The terminal claims the discovery decision must cover. */
  readonly terminalClaims: readonly ExternalReference[];
}

export interface DiscoveryEnvelopeInputs {
  readonly roleContract: CanonicalRoleContract;
  readonly taskSummary: string;
  readonly requiredInfo: RequiredIdeaInfo;
  /** Declared hook context (from the installed manifest; carried, never branched on). */
  readonly hookContext?: readonly string[];
  /** Retained tool results of a prior request (mid-loop continuation). */
  readonly toolResults?: readonly string[];
}

/**
 * Assemble the Discovery context envelope. The skill layers carry the
 * pinned digests of the SAME resolved contract; the task projection embeds
 * the bounded summaries of every required idea/unknown/terminal-claim entry
 * plus its exact content address (never silently dropped).
 */
export function assembleDiscoveryEnvelope(inputs: DiscoveryEnvelopeInputs, manifest: InstalledWorkshopManifest): ContextEnvelope {
  const contract = inputs.roleContract;
  const layers: EnvelopeLayer[] = [
    { layer: 'initial-prompt-frame', content: `Workshop production task. ${inputs.taskSummary}` },
    { layer: 'protocol-skill', content: `${contract.protocolSkillRef} digest=${contract.protocolSkillDigest}` },
    { layer: 'semantic-skill', content: `${contract.semanticSkillRef} digest=${contract.semanticSkillDigest}` },
    { layer: 'tool-schemas', content: manifest.tools.map((tool) => tool.schema).join('\n') },
    { layer: 'write-authority', content: `write authority: cell workspace only; allowed=${contract.allowedToolRefs.join(',')}` },
    {
      layer: 'task-projection',
      boundedTransportForm: true,
      content: taskProjectionContent(inputs.requiredInfo, inputs.taskSummary),
      externalReferences: [
        ...inputs.requiredInfo.idea,
        ...inputs.requiredInfo.unknowns,
        ...inputs.requiredInfo.terminalClaims,
      ],
    },
  ];
  if (inputs.hookContext !== undefined && inputs.hookContext.length > 0) {
    layers.push({ layer: 'hook-context', content: inputs.hookContext.join('\n') });
  }
  if (inputs.toolResults !== undefined && inputs.toolResults.length > 0) {
    layers.push({ layer: 'tool-results', content: inputs.toolResults.join('\n') });
  }
  return { layers };
}

function taskProjectionContent(requiredInfo: RequiredIdeaInfo, summary: string): string {
  const lines = [`task: ${summary}`];
  const entry = (label: string, refs: readonly ExternalReference[]): string[] =>
    refs.map((ref, index) => `${label}[${index}] ${ref.ref} :: ${ref.summary}`);
  lines.push(...entry('idea', requiredInfo.idea));
  lines.push(...entry('unknown', requiredInfo.unknowns));
  lines.push(...entry('terminal-claim', requiredInfo.terminalClaims));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* The scripted actor (an ordinary cognition client)                   */
/* ------------------------------------------------------------------ */

export interface ActorToolCall {
  readonly name: string;
  readonly args: readonly string[];
}

/** The gate verdict vocabulary an actor may surface (the frozen five). */
export type ActorVerdict = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

/** One scripted response: the ordinary outputs of ONE provider request. */
export interface ScriptedResponse {
  readonly toolCalls?: readonly ActorToolCall[];
  readonly text?: string;
  /** The ordinary product digest + description (never a factory fact). */
  readonly product?: { readonly digest: string; readonly description: string };
  /** A human-wait request routes to the driver's public command path. */
  readonly humanWait?: string;
  readonly verdict?: ActorVerdict;
}

export interface ActorScript {
  readonly responses: readonly ScriptedResponse[];
}

export interface ActorRunResult {
  readonly attemptRef: string;
  readonly requestCount: number;
  readonly receipts: readonly PromptAssemblyReceipt[];
  readonly toolCalls: readonly ActorToolCall[];
  readonly text: readonly string[];
  readonly products: readonly { readonly digest: string; readonly description: string }[];
  readonly humanWaitRequest?: { readonly question: string };
  readonly verdict?: ActorVerdict;
  readonly outcomeDigest: string;
}

export type ActorRefusalReason = 'MALFORMED_ACTOR' | 'ACTOR_TRANSPORT_REFUSED';

export type ActorRunOutcome =
  | { readonly ran: true; readonly result: ActorRunResult }
  | { readonly refused: true; readonly reason: ActorRefusalReason; readonly detail: string };

/** Parse/validate a script (a malformed actor is refused, never guessed). */
export function validateScript(script: ActorScript): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  if (script === null || typeof script !== 'object' || !Array.isArray(script.responses) || script.responses.length === 0) {
    return { ok: false, detail: 'a script must hold at least one response' };
  }
  for (const [index, response] of script.responses.entries()) {
    if (response === null || typeof response !== 'object') {
      return { ok: false, detail: `script response ${index} is not an object` };
    }
    if (response.product !== undefined && !/^[0-9a-f]{64}$/.test(response.product.digest ?? '')) {
      return { ok: false, detail: `script response ${index}: product requires a sha256 hex digest` };
    }
    if (response.verdict !== undefined && !['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'].includes(response.verdict)) {
      return { ok: false, detail: `script response ${index}: unknown verdict ${String(response.verdict)}` };
    }
  }
  return { ok: true };
}

export interface ActorLaunchPins {
  readonly attemptRef: string;
  readonly roleContract: CanonicalRoleContract;
  readonly taskSummary: string;
  readonly requiredInfo: RequiredIdeaInfo;
  readonly manifest: InstalledWorkshopManifest;
  readonly hookContext?: readonly string[];
  readonly idempotencyKeyPrefix: string;
  readonly expectedContextRevision: number;
}

/**
 * The scripted actor: each scripted response drives one provider request
 * through the shared transport (full admission boundary, never bypassed).
 */
export class ScriptedWorkshopActor {
  constructor(
    private readonly transport: CognitionTransportContract,
    private readonly script: ActorScript,
  ) {}

  async run(launch: ActorLaunchPins): Promise<ActorRunOutcome> {
    const valid = validateScript(this.script);
    if (!valid.ok) {
      return { refused: true, reason: 'MALFORMED_ACTOR', detail: valid.detail };
    }
    const receipts: PromptAssemblyReceipt[] = [];
    const toolCalls: ActorToolCall[] = [];
    const texts: string[] = [];
    const products: { digest: string; description: string }[] = [];
    let humanWaitRequest: { question: string } | undefined;
    let verdict: ActorVerdict | undefined;
    let outcomeDigest = '';
    for (let index = 0; index < this.script.responses.length; index += 1) {
      const response = this.script.responses[index];
      const envelope = assembleDiscoveryEnvelope(
        {
          roleContract: launch.roleContract,
          taskSummary: launch.taskSummary,
          requiredInfo: launch.requiredInfo,
          ...(launch.hookContext !== undefined ? { hookContext: launch.hookContext } : {}),
        },
        launch.manifest,
      );
      const send: TransportSendResult = await this.transport.sendProviderRequest({
        attemptRef: launch.attemptRef,
        expectedContextRevision: launch.expectedContextRevision + index,
        envelope,
        idempotencyKey: `${launch.idempotencyKeyPrefix}#req-${index + 1}`,
      });
      if (send.kind === 'refused') {
        return { refused: true, reason: 'ACTOR_TRANSPORT_REFUSED', detail: `${send.refusal.kind}: ${send.refusal.detail}` };
      }
      if (send.kind !== 'delivered') {
        return { refused: true, reason: 'ACTOR_TRANSPORT_REFUSED', detail: `scripted actor requires a delivered provider outcome (got ${send.kind})` };
      }
      receipts.push(send.receipt);
      outcomeDigest = send.outcomeDigest;
      if (response.toolCalls !== undefined) toolCalls.push(...response.toolCalls);
      if (response.text !== undefined) texts.push(response.text);
      if (response.product !== undefined) products.push({ digest: response.product.digest, description: response.product.description });
      if (response.humanWait !== undefined) humanWaitRequest = { question: response.humanWait };
      if (response.verdict !== undefined) verdict = response.verdict;
    }
    return {
      ran: true,
      result: {
        attemptRef: launch.attemptRef,
        requestCount: receipts.length,
        receipts,
        toolCalls,
        text: texts,
        products,
        ...(humanWaitRequest !== undefined ? { humanWaitRequest } : {}),
        ...(verdict !== undefined ? { verdict } : {}),
        outcomeDigest,
      },
    };
  }
}

/** A deterministic in-process channel (still behind the full admission boundary). */
export class DeterministicChannel implements ProviderNetworkChannel {
  readonly sentSerializations: string[] = [];
  async send(input: { readonly serialized: string; readonly maxOutputTokens: number }): Promise<ProviderChannelResult> {
    this.sentSerializations.push(input.serialized);
    return { status: 'delivered', outcomeDigest: 'sha256:' + createHash('sha256').update(input.serialized, 'utf8').digest('hex') };
  }
}
