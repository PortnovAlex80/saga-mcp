/**
 * workflow-kernel/workshops/delivery/approval.ts - the release-approval
 * bridge on the new kernel (WP-11L, plan phase EK-8).
 *
 * LEGACY SEMANTICS, HONESTLY CONVERTED. The legacy bridge
 * (src/modules/delivery/infrastructure/sqlite-delivery-approval-inbox.ts)
 * paused the flow while the request was open; the UI/MCP recorded a
 * decision in the inbox; resuming re-entered the human node and received
 * the immutable, candidate/preflight/policy-bound decision. The new-kernel
 * equivalent (assignment point 6):
 *
 *   - the PAUSE is a TypedWait:human-input committed by
 *     workplace.settleEffect(effectOutcome: "human-wait") - the packaging
 *     effect is an externally-visible release action gated on operator
 *     approval, so its first settlement is the approval wait;
 *   - the WAKE SOURCE is the D12 operator disposition command
 *     workplace.resolveHumanResponse (declared wake command of the wait;
 *     nodeRun.recordHumanDecision is the frozen alternative approval-
 *     decision wake of the same wait kind, kept as vocabulary - see
 *     conveyor.ts header for the reducer-gap note);
 *   - the DECISION is immutable and candidate/preflight/policy-bound: the
 *     request pins the exact triple; the decision digest covers the triple
 *     plus status/decidedBy/rationale/provider; a second, different
 *     decision for one request is refused typed (IMMUTABLE); the identical
 *     decision replays (replayed: true) - never a second record;
 *   - the disposition travels through the PUBLIC command path: the
 *     decision ref is the evidence on workplace.resolveHumanResponse, the
 *     wait discharges atomically (WakeDischarge:human-response-command,
 *     D5) and obligation:resumeEffect carries the resumed packaging.
 *
 * NO IMPLICIT ROLLBACK (D12): a denied or absent decision never auto-fails
 * or auto-approves the release; the flow stays paused until the operator
 * disposition, and an automatic duplicate send/effect is structurally
 * absent (the conveyor never re-settles while the wait is pending).
 *
 * The inbox itself is a write-once, file-backed store the operator
 * provisions (request rows + decision rows, content-addressed). It holds
 * ZERO factory tables - kernel-side durability is the wait row, the wake
 * discharge and the command evidence.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256OfCanonical } from '../../domain/digest.js';
import { isDeclaredDecisionProvider } from './manifest.js';

/* ------------------------------------------------------------------ */
/* The approval request (candidate/preflight/policy-bound)             */
/* ------------------------------------------------------------------ */

export const DELIVERY_APPROVAL_REQUEST_SCHEMA = 'delivery.approval-request.v2';
export const DELIVERY_APPROVAL_DECISION_SCHEMA = 'delivery.approval-decision.v2';

/** The exact binding triple of a release approval request. */
export interface ApprovalBindingTriple {
  readonly candidateDigest: string;
  readonly preflightDigest: string;
  readonly policyDigest: string;
}

/** The open approval request (the pause's subject). */
export interface ReleaseApprovalRequest {
  readonly schemaVersion: typeof DELIVERY_APPROVAL_REQUEST_SCHEMA;
  readonly requestId: string;
  readonly binding: ApprovalBindingTriple;
  readonly requestedBy: string;
  readonly state: 'open' | 'decided';
}

/** The recorded operator decision (immutable once written). */
export interface ReleaseApprovalDecision {
  readonly schemaVersion: typeof DELIVERY_APPROVAL_DECISION_SCHEMA;
  readonly requestId: string;
  readonly binding: ApprovalBindingTriple;
  readonly status: 'approved' | 'denied' | 'expired';
  readonly decidedBy: string;
  readonly rationale: string;
  readonly providerId: string;
  readonly decisionRef: string;
  readonly decisionDigest: string;
}

/* ------------------------------------------------------------------ */
/* Typed refusals (closed set - the legacy error vocabulary, typed)     */
/* ------------------------------------------------------------------ */

export type ApprovalRefusalReason =
  | 'APPROVAL_REQUEST_ID_REQUIRED'
  | 'APPROVAL_DECIDED_BY_REQUIRED'
  | 'APPROVAL_RATIONALE_REQUIRED'
  | 'APPROVAL_REQUEST_REPLAY_MISMATCH'
  | 'APPROVAL_REQUEST_NOT_FOUND'
  | 'APPROVAL_PROVIDER_NOT_DECLARED'
  | 'APPROVAL_DECISION_IMMUTABLE'
  | 'APPROVAL_BINDING_MISMATCH';

export interface ApprovalRefusal {
  readonly refused: true;
  readonly reason: ApprovalRefusalReason;
  readonly detail: string;
}

export type ApprovalEnsureResult =
  | { readonly ensured: true; readonly request: ReleaseApprovalRequest; readonly created: boolean }
  | ApprovalRefusal;

export type ApprovalRecordResult =
  | { readonly recorded: true; readonly decision: ReleaseApprovalDecision }
  | { readonly replayed: true; readonly decision: ReleaseApprovalDecision }
  | ApprovalRefusal;

/* ------------------------------------------------------------------ */
/* The request inbox (write-once file rows)                            */
/* ------------------------------------------------------------------ */

function requestPath(inboxRoot: string, requestId: string): string {
  return join(inboxRoot, 'requests', `${requestId.replaceAll(':', '_')}.json`);
}

function decisionPath(inboxRoot: string, requestId: string): string {
  return join(inboxRoot, 'decisions', `${requestId.replaceAll(':', '_')}.json`);
}

/**
 * Ensure the approval request for one binding triple. The request id is
 * derived from the candidate digest (one request per candidate); a replay
 * with a DIFFERENT triple is the typed REPLAY_MISMATCH refusal (the legacy
 * DELIVERY_APPROVAL_REQUEST_REPLAY_MISMATCH law).
 */
export function ensureApprovalRequest(
  inboxRoot: string,
  requestId: string,
  binding: ApprovalBindingTriple,
  requestedBy: string,
): ApprovalEnsureResult {
  if (!requestId.trim()) {
    return { refused: true, reason: 'APPROVAL_REQUEST_ID_REQUIRED', detail: 'an approval request id is required' };
  }
  const path = requestPath(inboxRoot, requestId);
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as ReleaseApprovalRequest;
    if (
      existing.binding.candidateDigest !== binding.candidateDigest
      || existing.binding.preflightDigest !== binding.preflightDigest
      || existing.binding.policyDigest !== binding.policyDigest
    ) {
      return {
        refused: true,
        reason: 'APPROVAL_REQUEST_REPLAY_MISMATCH',
        detail: `approval request ${requestId} replays with a different binding (open: ${JSON.stringify(existing.binding)}, presented: ${JSON.stringify(binding)}); the request is candidate/preflight/policy-bound`,
      };
    }
    return { ensured: true, request: existing, created: false };
  }
  const request: ReleaseApprovalRequest = {
    schemaVersion: DELIVERY_APPROVAL_REQUEST_SCHEMA,
    requestId,
    binding,
    requestedBy,
    state: 'open',
  };
  mkdirSync(join(inboxRoot, 'requests'), { recursive: true });
  writeFileSync(path, JSON.stringify(request, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  return { ensured: true, request, created: true };
}

/** Read one request row (durable public reader of the inbox). */
export function readApprovalRequest(inboxRoot: string, requestId: string): ReleaseApprovalRequest | undefined {
  const path = requestPath(inboxRoot, requestId);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ReleaseApprovalRequest) : undefined;
}

/** Read one decision row (durable public reader of the inbox). */
export function readApprovalDecision(inboxRoot: string, requestId: string): ReleaseApprovalDecision | undefined {
  const path = decisionPath(inboxRoot, requestId);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ReleaseApprovalDecision) : undefined;
}

/* ------------------------------------------------------------------ */
/* The decision (immutable, provider-bound)                            */
/* ------------------------------------------------------------------ */

export interface RecordDecisionInput {
  readonly requestId: string;
  readonly status: 'approved' | 'denied' | 'expired';
  readonly decidedBy: string;
  readonly rationale: string;
  readonly providerId: string;
}

/**
 * Record the operator decision. The decision digest covers the EXACT
 * binding triple + status + decidedBy + rationale + providerId; the ref is
 * content-addressed. Immutability: an existing decision row replays only
 * when byte-identical; any difference is the typed IMMUTABLE refusal. The
 * provider must be a DECLARED authorized-decision provider
 * (manifest.ts), never an anonymous identity.
 */
export function recordApprovalDecision(inboxRoot: string, input: RecordDecisionInput): ApprovalRecordResult {
  if (!input.requestId.trim()) {
    return { refused: true, reason: 'APPROVAL_REQUEST_ID_REQUIRED', detail: 'an approval request id is required' };
  }
  if (!input.decidedBy.trim()) {
    return { refused: true, reason: 'APPROVAL_DECIDED_BY_REQUIRED', detail: 'the deciding operator identity is required' };
  }
  if (!input.rationale.trim()) {
    return { refused: true, reason: 'APPROVAL_RATIONALE_REQUIRED', detail: 'a decision rationale is required' };
  }
  const request = readApprovalRequest(inboxRoot, input.requestId);
  if (request === undefined) {
    return { refused: true, reason: 'APPROVAL_REQUEST_NOT_FOUND', detail: `approval request ${input.requestId} not found in the inbox` };
  }
  if (!isDeclaredDecisionProvider(input.providerId)) {
    return {
      refused: true,
      reason: 'APPROVAL_PROVIDER_NOT_DECLARED',
      detail: `decision provider ${input.providerId} is not a declared authorized-decision provider; an anonymous or foreign identity never decides a release`,
    };
  }
  const body = {
    schemaVersion: DELIVERY_APPROVAL_DECISION_SCHEMA,
    requestId: request.requestId,
    binding: request.binding,
    status: input.status,
    decidedBy: input.decidedBy,
    rationale: input.rationale,
    providerId: input.providerId,
  } as const;
  const decisionDigest = sha256OfCanonical(body);
  const decisionRef = `delivery-approval:${request.requestId}:${decisionDigest}`;
  const path = decisionPath(inboxRoot, request.requestId);
  const decision: ReleaseApprovalDecision = { ...body, decisionRef, decisionDigest };

  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8')) as ReleaseApprovalDecision;
    if (existing.decisionDigest !== decisionDigest) {
      return {
        refused: true,
        reason: 'APPROVAL_DECISION_IMMUTABLE',
        detail: `approval decision ${request.requestId} is immutable (recorded ${existing.decisionDigest}, presented ${decisionDigest}); the decision binds ${existing.binding.candidateDigest}/${existing.binding.preflightDigest}/${existing.binding.policyDigest} and never re-writes`,
      };
    }
    return { replayed: true, decision: existing };
  }
  mkdirSync(join(inboxRoot, 'decisions'), { recursive: true });
  writeFileSync(path, JSON.stringify(decision, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  // The request row flips to decided exactly once (write-once discipline:
  // the decided row is derived from the immutable decision).
  const decidedRequest: ReleaseApprovalRequest = { ...request, state: 'decided' };
  writeFileSync(requestPath(inboxRoot, request.requestId), JSON.stringify(decidedRequest, null, 2) + '\n', { encoding: 'utf8' });
  return { recorded: true, decision };
}

/* ------------------------------------------------------------------ */
/* The D5/D12 wait vocabulary (typed waits ONLY through this surface)   */
/* ------------------------------------------------------------------ */

/**
 * The vocabulary of the release-approval pause. The conveyor commits the
 * wait through workplace.settleEffect(effectOutcome "human-wait"); these
 * helpers describe - and the tests assert - that the pause and its wake
 * are EXACTLY the frozen D5/D12 vocabulary, with no workshop-invented
 * wait kind or wake source.
 */
export const RELEASE_APPROVAL_WAIT_KIND = 'TypedWait:human-input' as const;
export const RELEASE_APPROVAL_WAKE_COMMANDS = ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision'] as const;
export const RELEASE_APPROVAL_DISCHARGE_EVIDENCE = 'WakeDischarge:human-response-command' as const;

/** The disposition command payload: evidence binds the immutable decision. */
export interface OperatorDisposition {
  readonly command: 'workplace.resolveHumanResponse';
  readonly evidenceRefs: readonly string[];
  readonly operatorDispositionRef: string;
}

/**
 * The public command path of the operator disposition: the evidence refs
 * carry the immutable decision ref (candidate/preflight/policy-bound
 * decision evidence), the D12 operator disposition receipt reference.
 */
export function operatorDispositionOf(decision: ReleaseApprovalDecision): OperatorDisposition {
  return {
    command: 'workplace.resolveHumanResponse',
    evidenceRefs: [decision.decisionRef],
    operatorDispositionRef: decision.decisionRef,
  };
}
