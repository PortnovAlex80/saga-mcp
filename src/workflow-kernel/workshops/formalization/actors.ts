/**
 * workflow-kernel/workshops/formalization/actors.ts - the cognition actors
 * of the Formalization desks (WP-11F, plan phase EK-8 workshop conversion).
 *
 * THE COGNITION PORT: every actor implements the SAME port - the WP-18
 * CognitionTransportContract. Every provider request:
 *   1. is assembled into a ContextEnvelope from the SAME resolved role
 *      contract (formalization envelope; no reclassification);
 *   2. passes through the SAME cumulative context accountant at the exact
 *      pre-send boundary (transport.sendProviderRequest -> the ONE
 *      admitProviderRequest);
 *   3. persists the SAME PromptAssemblyReceipt schema through the SAME
 *      bound AttemptAdmissionStore (admitted|refused only, never `sent`).
 *
 * A SCRIPTED ACTOR is an ordinary cognition client: it returns ordinary
 * tool calls, text and AUTHORED PRODUCTS (unvalidated formalization product
 * objects). The desk's declared check provider validates them at the gate -
 * never the actor. It may NOT write factory tables, fabricate factory
 * receipts or skip ingress - structurally: this module imports no
 * persistence surface at all.
 *
 * Runtime human-wait scenarios route through the PUBLIC command path: the
 * actor surfaces a human-wait request; the DRIVER executes
 * workplace.enterHumanWait / workplace.resolveHumanResponse (typed waits,
 * D5/D12).
 *
 * PURITY: no SQL, no session, no factory table, no clock.
 */

import type { CanonicalRoleContract } from '../../domain/types.js';
import type { ContextEnvelope, PromptAssemblyReceipt } from '../../context-envelope/receipt.js';
import type { CognitionTransportContract, TransportSendResult } from '../../context-envelope/transport.js';
import type { FormalizationEnvelopeInputs, FormalizationRequiredInfo } from './envelope.js';
import { assembleFormalizationEnvelope } from './envelope.js';

/** An ordinary tool call an actor may return (a cognition result, not a fact). */
export interface ActorToolCall {
  readonly name: string;
  readonly args: readonly string[];
}

/** The gate verdict vocabulary an actor may surface (the frozen five). */
export type ActorVerdict = 'accepted' | 'repair' | 'upstream-repair' | 'human-wait' | 'terminal-reject';

/** One authored product an actor returns (unvalidated; the gate validates). */
export interface AuthoredProduct {
  readonly kind: string;
  readonly product: unknown;
}

/**
 * One scripted cognition response: the ordinary outputs of ONE provider
 * request. Composable: a response may carry tool calls AND text AND a
 * product AND a verdict at once.
 */
export interface FormalizationScriptedResponse {
  readonly toolCalls?: readonly ActorToolCall[];
  readonly text?: string;
  readonly product?: AuthoredProduct;
  /** A human-wait request routes to the driver's public command path. */
  readonly humanWait?: string;
  readonly verdict?: ActorVerdict;
  /** Tool results to carry into a FOLLOW-UP request's envelope. */
  readonly nextRequestToolResults?: readonly string[];
}

/** A deterministic script: one response per provider request. */
export interface FormalizationActorScript {
  readonly responses: readonly FormalizationScriptedResponse[];
}

/** What one completed actor run returns to the driver (ordinary results). */
export interface FormalizationActorRunResult {
  readonly attemptRef: string;
  readonly requestCount: number;
  readonly receipts: readonly PromptAssemblyReceipt[];
  readonly toolCalls: readonly ActorToolCall[];
  readonly text: readonly string[];
  readonly products: readonly AuthoredProduct[];
  readonly humanWaitRequest?: { readonly question: string };
  readonly verdict?: ActorVerdict;
  readonly outcomeDigest: string;
}

/** Typed actor refusals (closed set; fail-closed, never a silent skip). */
export type FormalizationActorRefusalReason =
  | 'MALFORMED_ACTOR'
  | 'ACTOR_TRANSPORT_REFUSED';

export type FormalizationActorRunOutcome =
  | { readonly ran: true; readonly result: FormalizationActorRunResult }
  | { readonly refused: true; readonly reason: FormalizationActorRefusalReason; readonly detail: string };

/* ------------------------------------------------------------------ */
/* Launch pins + the shared-port request                               */
/* ------------------------------------------------------------------ */

/** Launch-time pins every actor binds (from the resolved role slot). */
export interface FormalizationActorLaunchPins {
  readonly attemptRef: string;
  readonly roleContract: CanonicalRoleContract;
  readonly taskSummary: string;
  readonly requiredInfo: FormalizationRequiredInfo;
  readonly assembly?: Omit<FormalizationEnvelopeInputs, 'roleContract' | 'taskSummary' | 'requiredInfo'>;
  readonly idempotencyKeyPrefix: string;
  readonly expectedContextRevision: number;
}

/** Run one provider request through the SHARED port (assemble, admit, send). */
export async function runFormalizationCognitionRequest(
  transport: CognitionTransportContract,
  launch: FormalizationActorLaunchPins,
  stepIndex: number,
  assemblyOverrides?: Partial<Omit<FormalizationEnvelopeInputs, 'roleContract'>>,
): Promise<
  | { readonly kind: 'sent'; readonly send: TransportSendResult; readonly envelope: ContextEnvelope }
  | { readonly kind: 'refused'; readonly reason: FormalizationActorRefusalReason; readonly detail: string; readonly send: TransportSendResult }
> {
  const envelope = assembleFormalizationEnvelope({
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
export function validateFormalizationScript(script: FormalizationActorScript): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
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
    if (response.product !== undefined && (typeof response.product?.kind !== 'string' || response.product.kind.length === 0 || response.product.product === undefined)) {
      return { ok: false, detail: `script response ${index}: a product requires a kind and content` };
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

/** The scripted actor: ordinary tool calls, text, authored products and verdicts. */
export class FormalizationScriptedActor {
  constructor(
    private readonly transport: CognitionTransportContract,
    private readonly script: FormalizationActorScript,
  ) {}

  async run(launch: FormalizationActorLaunchPins): Promise<FormalizationActorRunOutcome> {
    const valid = validateFormalizationScript(this.script);
    if (!valid.ok) {
      return { refused: true, reason: 'MALFORMED_ACTOR', detail: valid.detail };
    }
    const receipts: PromptAssemblyReceipt[] = [];
    const toolCalls: ActorToolCall[] = [];
    const texts: string[] = [];
    const products: AuthoredProduct[] = [];
    let humanWaitRequest: { question: string } | undefined;
    let verdict: ActorVerdict | undefined;
    let outcomeDigest = '';

    for (let index = 0; index < this.script.responses.length; index += 1) {
      const response = this.script.responses[index];
      const priorToolResults = index === 0
        ? launch.assembly?.toolResults
        : this.script.responses[index - 1].nextRequestToolResults;
      const request = await runFormalizationCognitionRequest(this.transport, launch, index, priorToolResults === undefined ? {} : { toolResults: priorToolResults });
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
      if (response.product !== undefined) products.push({ kind: response.product.kind, product: response.product.product });
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
