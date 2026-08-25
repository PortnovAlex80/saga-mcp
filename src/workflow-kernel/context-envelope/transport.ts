/**
 * workflow-kernel/context-envelope/transport.ts - the cognition transport
 * contract (the interface WP-08's transport must implement) + the EK-12
 * pre-send boundary enforcement + the reference admitting transport
 * (WP-18).
 *
 * Authority: docs/refactoring/event-kernel/specs/context-envelope-semantics.md
 * sections 3.3 (linearization point), 5.4 (retry-charge table), 8 (crash
 * windows), 9 (pre-send transport requirement / EK-12) and frozen decision
 * D12 (effect/send uncertainty = operator disposition command receipt, never
 * an automatic duplicate of a non-idempotent external send).
 *
 * Laws implemented here:
 *   - The admission call sits at the EXACT pre-send boundary: after ALL
 *     assembly (skills, schemas, hooks, retained results, recovery), before
 *     serialization/network send. The network channel is unreachable
 *     without an admitted receipt (fail-closed).
 *   - EK-12: an opaque CLI loop that cannot expose every final request
 *     (including mid-loop requests after tool results) is NONCONFORMING -
 *     the transport refuses fail-closed instead of sending unaccounted
 *     bytes. Instrumented transport or refusal; no middle ground.
 *   - The transport enforces maxOutputTokens <= reservedOutputTokens or
 *     refuses the provider/model (no conservative output bound, no send).
 *   - Crash window before send: the SAME obligation and the SAME request
 *     ordinal are redriven; admission is NOT re-run (no new receipt, no new
 *     ordinal, no double cumulative charge).
 *   - Crash window after a non-idempotent send with unknown outcome: typed
 *     TypedWait:effect-uncertainty; the operator disposition command
 *     decides (D12); an automatic duplicate send is structurally blocked.
 *
 * PURITY: node builtins only; the admission policy + accountant of this
 * package. No provider SDK, no HTTP here (the channel is an injected
 * interface WP-08 owns).
 */

import { admitProviderRequest } from './admission.js';
import type { AdmissionOutcome, AdmissionPins, AttemptAdmissionStore, ProviderSendObligation } from './admission.js';
import { accountEnvelope } from './accountant.js';
import { layerDigestOf, normalizeEnvelopeLayers, serializeEnvelopeLayers } from './receipt.js';
import type { ContextEnvelope, PromptAssemblyReceipt, ProviderRoutePin } from './receipt.js';

/* ------------------------------------------------------------------ */
/* Typed pre-send refusals (fail-closed, closed vocabulary)            */
/* ------------------------------------------------------------------ */

export type PreSendRefusalKind =
  | 'OPAQUE_LOOP_NONCONFORMING'
  | 'OUTPUT_RESERVATION_EXCEEDED'
  | 'ADMISSION_REFUSED'
  | 'ADMISSION_STALE'
  | 'UNADMITTED_REQUEST'
  | 'ENVELOPE_DIGEST_MISMATCH'
  | 'SERIALIZED_BYTES_MISMATCH'
  | 'SEND_UNCERTAIN_DUPLICATE_BLOCKED'
  | 'UNKNOWN_OBLIGATION';

export interface PreSendRefusal {
  readonly refused: true;
  readonly kind: PreSendRefusalKind;
  readonly detail: string;
  readonly receipt?: PromptAssemblyReceipt;
}

/* ------------------------------------------------------------------ */
/* The network channel (WP-08 owned; injected here)                    */
/* ------------------------------------------------------------------ */

/** The result of one network send attempt. */
export type ProviderChannelResult =
  | { readonly status: 'delivered'; readonly outcomeDigest: string }
  /** Non-idempotent external send happened; the outcome is unknown (D12 window). */
  | { readonly status: 'unknown' };

/** The raw provider channel WP-08 implements. It never sees an unadmitted request. */
export interface ProviderNetworkChannel {
  send(input: {
    readonly serialized: string;
    readonly routePin: ProviderRoutePin;
    readonly maxOutputTokens: number;
  }): Promise<ProviderChannelResult>;
}

/* ------------------------------------------------------------------ */
/* Send results (send/outcome is separate from admission)              */
/* ------------------------------------------------------------------ */

export type TransportSendResult =
  | {
    readonly kind: 'delivered';
    readonly receipt: PromptAssemblyReceipt;
    readonly obligation: ProviderSendObligation;
    readonly outcomeDigest: string;
  }
  | {
    readonly kind: 'refused';
    readonly refusal: PreSendRefusal;
  }
  | {
    /** D12: send happened, outcome unknown - operator disposition command required. */
    readonly kind: 'effect-uncertainty';
    readonly waitKind: 'TypedWait:effect-uncertainty';
    readonly receipt: PromptAssemblyReceipt;
    readonly obligation: ProviderSendObligation;
    readonly disposition: 'operator-disposition-command-required';
    readonly detail: string;
  }
  | {
    /** Crash-window class "before send": redrive the SAME obligation + ordinal. */
    readonly kind: 'channel-error';
    readonly error: string;
    readonly receipt: PromptAssemblyReceipt;
    readonly obligation: ProviderSendObligation;
    readonly redrive: 'same-obligation-same-ordinal';
  };

/* ------------------------------------------------------------------ */
/* The transport contract WP-08 must implement                        */
/* ------------------------------------------------------------------ */

/**
 * CognitionTransportContract - the interface the WP-08 cognition transport
 * implements. Every member is part of the EK-12 conformance surface; an
 * implementation that cannot satisfy exposesMidLoopRequests must fail
 * closed (refuse every send) rather than send unaccounted bytes.
 */
export interface CognitionTransportContract {
  readonly transportId: string;
  /** The pinned route this transport serves (must equal the attempt pin). */
  readonly routePin: ProviderRoutePin;
  /** The transport-side output bound; must be <= profile.reservedOutputTokens. */
  readonly maxOutputTokens: number;
  /** EK-12: proves every final request (including mid-loop) is exposed pre-send. */
  readonly exposesMidLoopRequests: boolean;
  /** The exact pre-send boundary call (after ALL assembly, before serialization/network). */
  admitProviderRequest(input: {
    readonly attemptRef: string;
    readonly expectedContextRevision: number;
    readonly envelope: ContextEnvelope;
    readonly idempotencyKey: string;
  }): Promise<AdmissionOutcome>;
  /** Serializes exactly the admitted envelope; verifies the admitted receipt digests/bytes. */
  serializeAdmittedEnvelope(envelope: ContextEnvelope, receipt: PromptAssemblyReceipt): { readonly serialized: string } | PreSendRefusal;
  /** The ONLY send entry: runs behind the open providerSend obligation of an admitted receipt. */
  sendProviderRequest(input: {
    readonly attemptRef: string;
    readonly expectedContextRevision: number;
    readonly envelope: ContextEnvelope;
    readonly idempotencyKey: string;
  }): Promise<TransportSendResult>;
  /** Crash window (after admission commit, before send): redrive the SAME obligation + ordinal, no re-admission. */
  redriveProviderSend(idempotencyKey: string): Promise<TransportSendResult>;
}

/* ------------------------------------------------------------------ */
/* Pre-send boundary enforcement (EK-12)                              */
/* ------------------------------------------------------------------ */

/**
 * The fail-closed pre-send gate. Verifies the receipt is an ADMITTED one
 * (never `sent` - that vocabulary does not exist), the envelope layer
 * digests equal the admitted receipt digests, the serialized bytes are the
 * exact admitted byte count, and the output reservation law holds. Returns
 * the typed refusal otherwise; the caller must not reach the network.
 */
export function enforcePreSendBoundary(
  profile: { readonly reservedOutputTokens: number },
  receipt: PromptAssemblyReceipt,
  envelope: ContextEnvelope,
  serialized: string,
  options: { readonly maxOutputTokens: number },
): { readonly ok: true } | { readonly ok: false; readonly refusal: PreSendRefusal } {
  if (receipt.decision !== 'admitted') {
    return { ok: false, refusal: { refused: true, kind: 'UNADMITTED_REQUEST', detail: `receipt decision is "${receipt.decision}"; only an admitted PromptAssemblyReceipt may reach serialization/network`, receipt } };
  }
  if (options.maxOutputTokens > profile.reservedOutputTokens) {
    return { ok: false, refusal: { refused: true, kind: 'OUTPUT_RESERVATION_EXCEEDED', detail: `maxOutputTokens (${options.maxOutputTokens}) > reservedOutputTokens (${profile.reservedOutputTokens}); the provider/model is refused when no conservative output bound can be enforced` } };
  }
  const normalized = normalizeEnvelopeLayers(envelope.layers);
  if (!normalized.ok) {
    return { ok: false, refusal: { refused: true, kind: 'ENVELOPE_DIGEST_MISMATCH', detail: `envelope failed normalization: ${normalized.detail}`, receipt } };
  }
  const ordered = normalized.ordered;
  const digests = ordered.map(layerDigestOf);
  const names = ordered.map((layer) => layer.layer);
  if (digests.length !== receipt.layerDigests.length || digests.some((digest, index) => digest !== receipt.layerDigests[index]) || names.some((name, index) => name !== receipt.layerNames[index])) {
    return { ok: false, refusal: { refused: true, kind: 'ENVELOPE_DIGEST_MISMATCH', detail: 'the serialized envelope layers differ from the admitted receipt layers; the send must carry exactly the admitted bytes', receipt } };
  }
  const canonical = serializeEnvelopeLayers(ordered);
  if (canonical !== serialized) {
    return { ok: false, refusal: { refused: true, kind: 'SERIALIZED_BYTES_MISMATCH', detail: 'the transport serialization differs from the canonical serialization the accountant counted', receipt } };
  }
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  if (byteLength !== receipt.serializedRequestBytes) {
    return { ok: false, refusal: { refused: true, kind: 'SERIALIZED_BYTES_MISMATCH', detail: `serialized bytes (${byteLength}) != admitted receipt serializedRequestBytes (${receipt.serializedRequestBytes})`, receipt } };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* The reference admitting transport (EK-12 instrumented path)         */
/* ------------------------------------------------------------------ */

interface AdmittedBinding {
  readonly envelope: ContextEnvelope;
  readonly receipt: PromptAssemblyReceipt;
  readonly obligation: ProviderSendObligation;
  state: 'admitted-pending-send' | 'delivered' | 'uncertain';
}

export interface AdmittingTransportConfig {
  readonly transportId: string;
  readonly routePin: ProviderRoutePin;
  readonly maxOutputTokens: number;
  readonly pins: AdmissionPins;
  readonly store: AttemptAdmissionStore;
  readonly channel: ProviderNetworkChannel;
  /**
   * EK-12: true only when the transport can expose EVERY final request
   * (including mid-loop tool-result continuations) to the accountant before
   * send. False = fail-closed refusal mode (the opaque-loop posture).
   */
  readonly exposesMidLoopRequests: boolean;
}

/**
 * The instrumented transport: admission at the exact pre-send boundary,
 * fail-closed on every defect class, D12-typed uncertainty, same-obligation
 * redrive. WP-08 composes this with its provider channel; it can also
 * implement CognitionTransportContract directly against its own stack, but
 * then enforcePreSendBoundary + admitProviderRequest must be called at the
 * exact same boundary.
 */
export function createAdmittingTransport(config: AdmittingTransportConfig): CognitionTransportContract {
  const bindings = new Map<string, AdmittedBinding>();

  const refuse = (kind: PreSendRefusalKind, detail: string, receipt?: PromptAssemblyReceipt): TransportSendResult => ({
    kind: 'refused',
    refusal: { refused: true, kind, detail, receipt },
  });

  const transmit = async (binding: AdmittedBinding): Promise<TransportSendResult> => {
    const normalized = normalizeEnvelopeLayers(binding.envelope.layers);
    if (!normalized.ok) {
      return refuse('ENVELOPE_DIGEST_MISMATCH', `admitted envelope failed re-normalization: ${normalized.detail}`, binding.receipt);
    }
    const serialized = serializeEnvelopeLayers(normalized.ordered);
    const gate = enforcePreSendBoundary(config.pins.profile, binding.receipt, binding.envelope, serialized, { maxOutputTokens: config.maxOutputTokens });
    if (!gate.ok) {
      return { kind: 'refused', refusal: gate.refusal };
    }
    try {
      const result = await config.channel.send({ serialized, routePin: config.routePin, maxOutputTokens: config.maxOutputTokens });
      if (result.status === 'delivered') {
        binding.state = 'delivered';
        return { kind: 'delivered', receipt: binding.receipt, obligation: binding.obligation, outcomeDigest: result.outcomeDigest };
      }
      // D12: non-idempotent send with unknown outcome. Never an automatic
      // duplicate; the operator disposition command decides.
      binding.state = 'uncertain';
      return {
        kind: 'effect-uncertainty',
        waitKind: 'TypedWait:effect-uncertainty',
        receipt: binding.receipt,
        obligation: binding.obligation,
        disposition: 'operator-disposition-command-required',
        detail: 'the external send happened but its outcome is unknown; D12: operator disposition command receipt decides - never an automatic duplicate send, never a blind rollback',
      };
    } catch (error) {
      // Crash-window class "before send": the obligation is redriven with
      // the SAME ordinal; admission is NOT re-run; nothing is re-charged.
      return {
        kind: 'channel-error',
        error: error instanceof Error ? error.message : String(error),
        receipt: binding.receipt,
        obligation: binding.obligation,
        redrive: 'same-obligation-same-ordinal',
      };
    }
  };

  return {
    transportId: config.transportId,
    routePin: config.routePin,
    maxOutputTokens: config.maxOutputTokens,
    exposesMidLoopRequests: config.exposesMidLoopRequests,

    async admitProviderRequest(input): Promise<AdmissionOutcome> {
      return admitProviderRequest(config.pins, config.store, input);
    },

    serializeAdmittedEnvelope(envelope, receipt): { readonly serialized: string } | PreSendRefusal {
      const normalized = normalizeEnvelopeLayers(envelope.layers);
      if (!normalized.ok) {
        return { refused: true, kind: 'ENVELOPE_DIGEST_MISMATCH', detail: normalized.detail, receipt };
      }
      const serialized = serializeEnvelopeLayers(normalized.ordered);
      const gate = enforcePreSendBoundary(config.pins.profile, receipt, envelope, serialized, { maxOutputTokens: config.maxOutputTokens });
      if (!gate.ok) return gate.refusal;
      return { serialized };
    },

    async sendProviderRequest(input): Promise<TransportSendResult> {
      // EK-12: an opaque loop that cannot expose every final request is
      // nonconforming - fail closed, no network.
      if (!config.exposesMidLoopRequests) {
        return refuse('OPAQUE_LOOP_NONCONFORMING', 'this transport cannot expose every final request (incl. mid-loop) to the accountant; per the pre-send transport requirement it must refuse fail-closed rather than send unaccounted bytes');
      }
      // Output reservation law (section 3.3).
      if (config.maxOutputTokens > config.pins.profile.reservedOutputTokens) {
        return refuse('OUTPUT_RESERVATION_EXCEEDED', `maxOutputTokens (${config.maxOutputTokens}) > reservedOutputTokens (${config.pins.profile.reservedOutputTokens}); refusing this provider/model`);
      }
      const admission = await admitProviderRequest(config.pins, config.store, {
        attemptRef: input.attemptRef,
        expectedContextRevision: input.expectedContextRevision,
        envelope: input.envelope,
        idempotencyKey: input.idempotencyKey,
      });
      if (admission.kind === 'refused') {
        return refuse('ADMISSION_REFUSED', `admission refused: ${admission.violation}: ${admission.violationDetail}`, admission.receipt);
      }
      if (admission.kind === 'stale-revision') {
        return refuse('ADMISSION_STALE', admission.detail);
      }
      if (!admission.obligation) {
        return refuse('ADMISSION_REFUSED', 'idempotent replay of a refused admission: the identical envelope cannot be reissued', admission.receipt);
      }
      // Replay of a committed admission continues with the recorded
      // obligation + ordinal (the crash-before-send redrive path when the
      // caller re-invoked instead of using redriveProviderSend).
      const existing = bindings.get(admission.obligation.idempotencyKey);
      if (existing && existing.state === 'uncertain') {
        return refuse('SEND_UNCERTAIN_DUPLICATE_BLOCKED', 'a send with unknown outcome is pending operator disposition (D12); an automatic duplicate send is blocked', existing.receipt);
      }
      if (existing && existing.state === 'delivered') {
        return { kind: 'delivered', receipt: existing.receipt, obligation: existing.obligation, outcomeDigest: 'idempotent-redrive:already-delivered' };
      }
      const obligation = admission.obligation;
      const receipt = admission.receipt;
      const binding: AdmittedBinding = { envelope: input.envelope, receipt, obligation, state: 'admitted-pending-send' };
      bindings.set(obligation.idempotencyKey, binding);
      return transmit(binding);
    },

    async redriveProviderSend(idempotencyKey): Promise<TransportSendResult> {
      const binding = bindings.get(idempotencyKey);
      if (!binding) {
        // No admitted binding: either the crash happened before the
        // admission commit (re-run admission from scratch - section 8 row 1)
        // or the key is foreign. Fail closed either way.
        return refuse('UNKNOWN_OBLIGATION', `no admitted provider-send binding for idempotency key ${idempotencyKey}; if the crash preceded the admission commit, re-run admitProviderRequest from scratch`);
      }
      if (binding.state === 'uncertain') {
        return refuse('SEND_UNCERTAIN_DUPLICATE_BLOCKED', 'outcome unknown: operator disposition command required (D12); duplicate send blocked', binding.receipt);
      }
      if (binding.state === 'delivered') {
        return { kind: 'delivered', receipt: binding.receipt, obligation: binding.obligation, outcomeDigest: 'idempotent-redrive:already-delivered' };
      }
      // Same obligation, same ordinal, same admitted receipt; admission is
      // NOT re-run; cumulative input is NOT re-charged (section 5.4 row 3).
      return transmit(binding);
    },
  };
}

/**
 * Scale probe helper for tests/diagnostics: runs the accountant over an
 * envelope WITHOUT any admission side effects (the deterministic oracle the
 * EK-12 preflight probes reuse).
 */
export function probeAccounting(pins: AdmissionPins, attempt: Parameters<typeof accountEnvelope>[2], envelope: ContextEnvelope) {
  return accountEnvelope(pins.profile, pins.limitTable, attempt, envelope);
}
