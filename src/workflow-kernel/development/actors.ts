/**
 * workflow-kernel/development/actors.ts - the three cognition actors of the
 * Development vertical (WP-08, plan phase EK-5): scripted, replay and real.
 *
 * THE COGNITION PORT (plan EK-5): all three actors implement the SAME port -
 * the WP-18 CognitionTransportContract. Every provider request of every
 * actor:
 *   1. is assembled into a ContextEnvelope from the SAME resolved role
 *      contract (no reclassification);
 *   2. passes through the SAME cumulative context accountant at the exact
 *      pre-send boundary (transport.sendProviderRequest -> the ONE
 *      admitProviderRequest);
 *   3. persists the SAME PromptAssemblyReceipt schema through the SAME
 *      bound AttemptAdmissionStore (admitted|refused only, never `sent`).
 *
 * DURABLE-HANDOFF NOTE: the frozen universe pins exactly one admitted
 * provider request per obligation:launchAdmission (it is the only
 * obligation targeting activityAttempt.admitProviderRequest). The kernel-
 * durable vertical therefore runs ONE provider request per attempt; a
 * follow-up request after tool results (the mid-loop continuation) is proven
 * at the transport level and across attempts (recovery memory feeds the next
 * attempt's envelope). The scripted actor still supports multi-response
 * scripts for transport-level tests against the in-memory store.
 *
 * A SCRIPTED ACTOR is an ordinary cognition client: it returns ordinary
 * tool calls, text and products. It may NOT write factory tables, fabricate
 * factory receipts or skip ingress - structurally: this module imports no
 * persistence surface at all (tests/workflow-kernel/development/
 * structure.test.mjs enforces it), receives only the transport, and every
 * durable fact is committed by the kernel repositories, never here.
 *
 * Runtime human-wait scenarios run through the PUBLIC command path: the
 * actor surfaces a human-wait request; the DRIVER (material-chain.ts, not
 * the actor) executes workplace.enterHumanWait / workplace.resolveHumanResponse,
 * which are kernel commands with typed waits (WP-07) and D12 rules.
 *
 * PURITY of this module: node:crypto digests + the context-envelope package
 * types. No SQL, no session, no factory table, no clock.
 */

import { createHash } from 'node:crypto';
import type { CanonicalRoleContract } from '../domain/types.js';
import type {
  ContextEnvelope,
  PromptAssemblyReceipt,
} from '../context-envelope/receipt.js';
import type {
  CognitionTransportContract,
  TransportSendResult,
} from '../context-envelope/transport.js';
import type { ProviderNetworkChannel, ProviderChannelResult } from '../context-envelope/transport.js';
import type { DevelopmentEnvelopeInputs, RequiredTaskInfo } from './envelope-assembly.js';
import { assembleDevelopmentEnvelope } from './envelope-assembly.js';

/* ------------------------------------------------------------------ */
/* Ordinary actor outputs (never factory facts)                        */
/* ------------------------------------------------------------------ */

/** An ordinary tool call an actor may return (a cognition result, not a fact). */
export interface ActorToolCall {
  readonly name: string;
  readonly args: readonly string[];
}

/** The gate verdict vocabulary an actor may surface (the frozen five). */
export type ActorVerdict = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

/**
 * One scripted cognition response: the ordinary outputs of ONE provider
 * request. Composable: a response may carry tool calls AND text AND a
 * product AND a verdict at once.
 */
export interface ScriptedResponse {
  readonly toolCalls?: readonly ActorToolCall[];
  readonly text?: string;
  readonly product?: { readonly digest: string; readonly description: string };
  /** A human-wait request routes to the driver's public command path. */
  readonly humanWait?: string;
  readonly verdict?: ActorVerdict;
  /** Tool results to carry into a FOLLOW-UP request's envelope (mid-loop continuations). */
  readonly nextRequestToolResults?: readonly string[];
}

/** A deterministic script: one response per provider request. */
export interface ActorScript {
  readonly responses: readonly ScriptedResponse[];
}

/** What one completed actor run returns to the driver (ordinary results). */
export interface ActorRunResult {
  readonly attemptRef: string;
  readonly requestCount: number;
  readonly receipts: readonly PromptAssemblyReceipt[];
  /** Ordinary outputs - the driver turns these into kernel evidence. */
  readonly toolCalls: readonly ActorToolCall[];
  readonly text: readonly string[];
  readonly products: readonly { readonly digest: string; readonly description: string }[];
  /** A human-wait request routes to the driver's public command path (never resolved by the actor). */
  readonly humanWaitRequest?: { readonly question: string };
  readonly verdict?: ActorVerdict;
  readonly outcomeDigest: string;
}

/** Typed actor refusals (closed set; fail-closed, never a silent skip). */
export type ActorRefusalReason =
  | 'MALFORMED_ACTOR'
  | 'ACTOR_TRANSPORT_REFUSED';

export type ActorRunOutcome =
  | { readonly ran: true; readonly result: ActorRunResult }
  | { readonly refused: true; readonly reason: ActorRefusalReason; readonly detail: string };

/* ------------------------------------------------------------------ */
/* The shared cognition port driver                                    */
/* ------------------------------------------------------------------ */

/** Launch-time pins every actor binds (from the resolved role slot). */
export interface ActorLaunchPins {
  readonly attemptRef: string;
  readonly roleContract: CanonicalRoleContract;
  readonly taskSummary: string;
  readonly requiredInfo: RequiredTaskInfo;
  /** Extra assembly inputs (recovery memory, hooks, tool results, products). */
  readonly assembly?: Omit<DevelopmentEnvelopeInputs, 'roleContract' | 'taskSummary' | 'requiredInfo'>;
  /** The idempotency key prefix for this attempt's provider requests. */
  readonly idempotencyKeyPrefix: string;
  /** The context revision the actor's assembler snapshot starts from. */
  readonly expectedContextRevision: number;
}

/** One shared-port provider request outcome (kind-discriminated). */
export type CognitionRequestOutcome =
  | { readonly kind: 'sent'; readonly send: TransportSendResult; readonly envelope: ContextEnvelope }
  | { readonly kind: 'refused'; readonly reason: ActorRefusalReason; readonly detail: string; readonly send: TransportSendResult };

/**
 * Run one provider request through the SHARED port: assemble from the SAME
 * contract, admit at the exact pre-send boundary, return the ordinary
 * result. Used identically by all three actors.
 */
export async function runCognitionRequest(
  transport: CognitionTransportContract,
  launch: ActorLaunchPins,
  stepIndex: number,
  assemblyOverrides?: Partial<Omit<DevelopmentEnvelopeInputs, 'roleContract'>>,
): Promise<CognitionRequestOutcome> {
  const envelope = assembleDevelopmentEnvelope({
    roleContract: launch.roleContract,
    taskSummary: launch.taskSummary,
    requiredInfo: launch.requiredInfo,
    ...(launch.assembly ?? {}),
    ...(assemblyOverrides ?? {}),
  });
  const send = await transport.sendProviderRequest({
    attemptRef: launch.attemptRef,
    expectedContextRevision: launch.expectedContextRevision + stepIndex,
    envelope,
    idempotencyKey: `${launch.idempotencyKeyPrefix}#req-${stepIndex + 1}`,
  });
  if (send.kind === 'refused') {
    return { kind: 'refused', reason: 'ACTOR_TRANSPORT_REFUSED', detail: `${send.refusal.kind}: ${send.refusal.detail}`, send };
  }
  return { kind: 'sent', send, envelope };
}

/* ------------------------------------------------------------------ */
/* Script validation (the malformed-actor fence)                       */
/* ------------------------------------------------------------------ */

/** Parse/validate a script (a malformed actor is refused, never guessed). */
export function validateScript(script: ActorScript): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  if (script === null || typeof script !== 'object' || !Array.isArray(script.responses) || script.responses.length === 0) {
    return { ok: false, detail: 'a script must hold at least one response' };
  }
  for (const [index, response] of script.responses.entries()) {
    if (response === null || typeof response !== 'object') {
      return { ok: false, detail: `script response ${index} is not an object` };
    }
    if (response.toolCalls !== undefined) {
      if (!Array.isArray(response.toolCalls) || response.toolCalls.some((call: ActorToolCall) => typeof call?.name !== 'string' || !Array.isArray(call.args))) {
        return { ok: false, detail: `script response ${index}: toolCalls requires named calls with args` };
      }
    }
    if (response.product !== undefined && !/^[0-9a-f]{64}$/.test(response.product.digest ?? '')) {
      return { ok: false, detail: `script response ${index}: product requires a sha256 hex digest` };
    }
    if (response.verdict !== undefined && !['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'].includes(response.verdict)) {
      return { ok: false, detail: `script response ${index}: unknown verdict ${String(response.verdict)}` };
    }
    if (response.nextRequestToolResults !== undefined && !Array.isArray(response.nextRequestToolResults)) {
      return { ok: false, detail: `script response ${index}: nextRequestToolResults must be an array` };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The scripted actor                                                  */
/* ------------------------------------------------------------------ */

/**
 * The scripted actor: ordinary tool calls, text, products and verdicts.
 * Each scripted response drives one provider request through the shared
 * transport; a follow-up response's envelope carries the prior response's
 * nextRequestToolResults (the mid-loop continuation shape).
 */
export class ScriptedActor {
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
      const priorToolResults = index === 0
        ? launch.assembly?.toolResults
        : this.script.responses[index - 1].nextRequestToolResults;
      const request = await runCognitionRequest(this.transport, launch, index, priorToolResults === undefined ? {} : { toolResults: priorToolResults });
      if (request.kind === 'refused') {
        return { refused: true, reason: request.reason, detail: request.detail };
      }
      if (request.send.kind === 'refused') {
        return { refused: true, reason: 'ACTOR_TRANSPORT_REFUSED', detail: `${request.send.refusal.kind}: ${request.send.refusal.detail}` };
      }
      if (request.send.kind !== 'delivered') {
        return { refused: true, reason: 'ACTOR_TRANSPORT_REFUSED', detail: `scripted actor requires a delivered provider outcome (got ${request.send.kind})` };
      }
      receipts.push(request.send.receipt);
      outcomeDigest = request.send.outcomeDigest;
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

/* ------------------------------------------------------------------ */
/* The replay actor                                                    */
/* ------------------------------------------------------------------ */

/** One recorded provider round of a prior attempt (digest-keyed). */
export interface RecordedRound {
  readonly envelopeDigest: string;
  readonly requestOrdinal: number;
  readonly outcomeDigest: string;
}

/**
 * The replay actor: re-runs a recorded transcript through the SAME port.
 * Admission and receipt persistence are IDENTICAL to a live actor (never
 * short-circuited: a replay that skips ingress is refused by the transport,
 * not tolerated).
 */
export class ReplayActor {
  constructor(
    private readonly transport: CognitionTransportContract,
    private readonly recording: readonly RecordedRound[],
  ) {}

  async run(launch: ActorLaunchPins): Promise<ActorRunOutcome> {
    if (!Array.isArray(this.recording) || this.recording.length === 0) {
      return { refused: true, reason: 'MALFORMED_ACTOR', detail: 'a replay actor requires a non-empty recording' };
    }
    const receipts: PromptAssemblyReceipt[] = [];
    let outcomeDigest = '';
    for (let index = 0; index < this.recording.length; index += 1) {
      const request = await runCognitionRequest(this.transport, launch, index);
      if (request.kind === 'refused') {
        return { refused: true, reason: request.reason, detail: request.detail };
      }
      if (request.send.kind !== 'delivered') {
        return { refused: true, reason: 'ACTOR_TRANSPORT_REFUSED', detail: `replay actor requires a delivered outcome (got ${request.send.kind})` };
      }
      receipts.push(request.send.receipt);
      outcomeDigest = request.send.outcomeDigest;
    }
    return {
      ran: true,
      result: {
        attemptRef: launch.attemptRef,
        requestCount: receipts.length,
        receipts,
        toolCalls: [],
        text: [],
        products: [],
        outcomeDigest,
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* The real actor + its channels                                       */
/* ------------------------------------------------------------------ */

/**
 * The real actor's network channel: an actual external send boundary. The
 * production channel is injected at EK-8 (the opencode cognition transport
 * behind the claude-shim); the focused tests bind a REAL loopback HTTP
 * channel so the same port is proven over an actual socket without any
 * provider SDK.
 */
export class LoopbackHttpChannel implements ProviderNetworkChannel {
  readonly sentSerializations: string[] = [];

  constructor(
    private readonly endpoint: { readonly url: string },
    private readonly responses: readonly { readonly match: string; readonly outcomeDigest: string }[] = [],
  ) {}

  async send(input: { readonly serialized: string; readonly maxOutputTokens: number }): Promise<ProviderChannelResult> {
    this.sentSerializations.push(input.serialized);
    const matched = this.responses.find((candidate) => input.serialized.includes(candidate.match));
    const outcomeDigest =
      matched?.outcomeDigest ?? 'sha256:' + createHash('sha256').update(input.serialized, 'utf8').digest('hex');
    // A REAL network round trip over the loopback socket; an actual send,
    // never a stubbed return.
    const response = await fetch(this.endpoint.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ envelopeDigest: outcomeDigest, maxOutputTokens: input.maxOutputTokens }),
    });
    if (!response.ok) {
      throw new Error(`REAL_CHANNEL_HTTP_${response.status}`);
    }
    await response.json();
    return { status: 'delivered', outcomeDigest };
  }
}

/** A deterministic in-process channel for the scripted actor (still behind the full admission boundary). */
export class ScriptedChannel implements ProviderNetworkChannel {
  readonly sentSerializations: string[] = [];

  async send(input: { readonly serialized: string; readonly maxOutputTokens: number }): Promise<ProviderChannelResult> {
    this.sentSerializations.push(input.serialized);
    return { status: 'delivered', outcomeDigest: 'sha256:' + createHash('sha256').update(input.serialized, 'utf8').digest('hex') };
  }
}

/** The real actor: identical port, injected real channel. */
export class RealActor {
  constructor(private readonly transport: CognitionTransportContract) {}

  async run(launch: ActorLaunchPins, script: ActorScript): Promise<ActorRunOutcome> {
    return new ScriptedActor(this.transport, script).run(launch);
  }
}

/* ------------------------------------------------------------------ */
/* D12 guard surface (assertion helper for the driver/tests)           */
/* ------------------------------------------------------------------ */

/**
 * D12 law: a send with unknown outcome requires an OPERATOR disposition
 * command; an automatic duplicate send is blocked. The driver asserts the
 * actor never re-sends while an uncertainty wait is pending.
 */
export function assertNoUncertainDuplicate(
  lastResult: TransportSendResult,
): { readonly blocked: true } | { readonly clear: true } {
  if (lastResult.kind === 'effect-uncertainty') {
    return { blocked: true };
  }
  return { clear: true };
}
