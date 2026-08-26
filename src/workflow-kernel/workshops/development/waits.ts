/**
 * workflow-kernel/workshops/development/waits.ts - the TYPED WAITS of the
 * converted workshop (WP-11V, plan EK-8): D5/D12 declarations only, taken
 * from the frozen five-kind wait registry - the workshop invents no wait
 * kind and no wake source.
 *
 * Two waits are installed:
 *   1. certification readiness (Elite-2): readiness-for-certification
 *      cannot be observed by the machine; the effect settlement surfaces
 *      the frozen TypedWait:human-input and ONLY the operator disposition
 *      command (workplace.resolveHumanResponse) wakes it;
 *   2. effect uncertainty (D12): a non-idempotent external effect with an
 *      unknown outcome never redrives automatically - the wake is the
 *      operator disposition command receipt.
 *
 * The operator disposition receipt is content-addressed evidence: the
 * operator identity, the readiness manifest it disposes and the decision
 * are hashed canonically, so the discharge is auditable forever.
 *
 * PURITY: pure builders over data. No I/O, no session, no clock.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { WaitDeclaration } from './installation.js';

/** The installed wait declarations (frozen kinds, frozen wake sources). */
export function developmentWaitDeclarations(): readonly WaitDeclaration[] {
  return [
    {
      purpose: 'certification.readiness',
      kind: 'TypedWait:human-input',
      wakeCommands: ['workplace.resolveHumanResponse'],
      operatorDispositionRequired: true,
      rationale: 'Elite-2: readiness-for-certification cannot be observed by the machine; the operator disposes it and the effect resumes idempotently (already-applied)',
    },
    {
      purpose: 'effect.uncertainty',
      kind: 'TypedWait:effect-uncertainty',
      wakeCommands: ['workplace.resolveHumanResponse'],
      operatorDispositionRequired: true,
      rationale: 'D12: an uncertain non-idempotent external effect wakes only on an operator disposition receipt; an automatic duplicate send is refused',
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The operator disposition receipt                                    */
/* ------------------------------------------------------------------ */

/** The decision vocabulary an operator may dispose over a readiness manifest. */
export type OperatorReadinessDecision =
  | 'readiness-certified'
  | 'readiness-rejected';

/** One durable operator disposition over a readiness manifest (D12/Elite-2 evidence). */
export interface OperatorDispositionReceipt {
  readonly schemaId: 'workshop.development.operator-disposition.v1';
  readonly operatorId: string;
  readonly readinessManifestDigest: string;
  readonly decision: OperatorReadinessDecision;
  readonly note: string;
  readonly digest: string;
  readonly ref: string;
}

/** Build the content-addressed operator disposition receipt (pure). */
export function buildOperatorDisposition(input: {
  readonly operatorId: string;
  readonly readinessManifestDigest: string;
  readonly decision: OperatorReadinessDecision;
  readonly note: string;
}): OperatorDispositionReceipt {
  const body: Omit<OperatorDispositionReceipt, 'digest' | 'ref'> = {
    schemaId: 'workshop.development.operator-disposition.v1',
    operatorId: input.operatorId,
    readinessManifestDigest: input.readinessManifestDigest,
    decision: input.decision,
    note: input.note,
  };
  const digest = sha256OfCanonical(body);
  return { ...body, digest, ref: `sha256:${digest}` };
}

/** Verify a disposition receipt against its canonical body (fail-closed). */
export function verifyOperatorDisposition(receipt: OperatorDispositionReceipt): { readonly verified: true } | { readonly verified: false; readonly detail: string } {
  const body = {
    schemaId: receipt.schemaId,
    operatorId: receipt.operatorId,
    readinessManifestDigest: receipt.readinessManifestDigest,
    decision: receipt.decision,
    note: receipt.note,
  };
  const recomputed = sha256OfCanonical(body);
  if (recomputed !== receipt.digest || receipt.ref !== `sha256:${receipt.digest}`) {
    return { verified: false, detail: `the disposition receipt ${receipt.ref} does not verify against its canonical body (recomputed ${recomputed})` };
  }
  if (receipt.decision !== 'readiness-certified' && receipt.decision !== 'readiness-rejected') {
    return { verified: false, detail: `unknown disposition decision ${String(receipt.decision)}` };
  }
  return { verified: true };
}
