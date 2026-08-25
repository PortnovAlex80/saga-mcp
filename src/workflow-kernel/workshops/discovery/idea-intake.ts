/**
 * workflow-kernel/workshops/discovery/idea-intake.ts - the content-addressed
 * idea intake bundle and its PUBLIC ingress (WP-11D).
 *
 * Discovery is the FIRST stage: its input is the operator's idea, not a
 * producing parent lifecycle's capsule. The kernel's only ingress surface
 * is factoryRun.bootstrap + factoryRun.importCapsule (the 53-command
 * universe is closed), so the idea bundle enters through exactly that
 * public path - the CapsuleIngressReceipt it records is what makes
 * factoryRun.start lawful for the discovery run.
 *
 * Laws (mirroring the development capsule discipline):
 *   - The bundle is content-addressed and versioned; every digest is
 *     recomputed over canonical content at ingress, never trusted.
 *   - The idea product itself is validated against the installed
 *     idea-intake product contract (a malformed idea is a typed
 *     MALFORMED_PRODUCT refusal, never an inferred default).
 *   - Typed fail-closed refusals, frozen check order:
 *       STALE_PROTOCOL        bundle protocol version is not current;
 *       BYTES_CORRUPT         any verified digest mismatch;
 *       BYTES_MISSING         intake bytes absent/empty;
 *       MALFORMED_PRODUCT     the idea product fails its contract;
 *       FOREIGN_LINEAGE       lineage does not match the operator binding
 *                             (Discovery's parent lifecycle is null - the
 *                             first stage has no producing parent);
 *       ILLEGAL_PARENT_STATE  parent state is not the operator intake
 *                             decision (a non-intake parent cannot start
 *                             discovery);
 *       ACTIVE_ATTEMPT        target database holds a live attempt.
 *
 * PURITY of verification: node:crypto-free (domain digest rule only). The
 * single mutation surface is the KernelPersistenceSession the focused
 * tests own.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { CommandOutcome } from '../../domain/types.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';
import { validateProduct, type SealedProduct } from './products.js';

/** Exact protocol identity of the idea intake bundle. */
export const IDEA_BUNDLE_PROTOCOL_VERSION = 'ek.idea-intake-bundle.ek8.v1' as const;

/** The one legal producing parent state (the operator's intake decision). */
export const IDEA_LEGAL_PARENT_STATES = ['operator-intake'] as const;
export type IdeaParentStatus = (typeof IDEA_LEGAL_PARENT_STATES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const FACTORY_INSTANCE = 'factory-run:1';

/* ------------------------------------------------------------------ */
/* The bundle value                                                    */
/* ------------------------------------------------------------------ */

/** Lineage binding: the first stage has NO producing parent lifecycle. */
export interface IdeaLineage {
  readonly lineageId: string;
  readonly parentLifecycleRef: null;
}

/** The operator's intake decision fact carried inside the bundle. */
export interface IdeaParentState {
  readonly status: IdeaParentStatus | string;
  /** Content address of the operator's decision-to-start artifact. */
  readonly decisionRef: string;
}

/** The sealed, self-addressed idea intake bundle. */
export interface IdeaIntakeBundle {
  readonly schemaVersion: typeof IDEA_BUNDLE_PROTOCOL_VERSION;
  readonly bundleRef: string;
  readonly bundleDigest: string;
  readonly lineage: IdeaLineage;
  readonly parentState: IdeaParentState;
  /** The idea-intake INPUT product (sealed, content-addressed). */
  readonly idea: SealedProduct;
  /** sha256 (hex) over the exact operator intake bytes. */
  readonly intakeBytesDigest: string;
}

/** Build the sealed bundle; the bundle digest covers the canonical facts. */
export function buildIdeaBundle(
  idea: SealedProduct,
  lineage: IdeaLineage,
  parentState: IdeaParentState,
  intakeBytes: Uint8Array,
): IdeaIntakeBundle {
  const intakeBytesDigest = sha256OfCanonical([...intakeBytes]);
  const body = {
    schemaVersion: IDEA_BUNDLE_PROTOCOL_VERSION,
    lineage,
    parentState,
    idea: { ref: idea.ref, digest: idea.digest },
    intakeBytesDigest,
  } as const;
  const bundleDigest = sha256OfCanonical(body);
  return { ...body, idea, bundleRef: `sha256:${bundleDigest}`, bundleDigest };
}

/* ------------------------------------------------------------------ */
/* Typed ingress refusals (closed set, frozen check order)             */
/* ------------------------------------------------------------------ */

export type IdeaIngressRefusalReason =
  | 'STALE_PROTOCOL'
  | 'BYTES_CORRUPT'
  | 'BYTES_MISSING'
  | 'MALFORMED_PRODUCT'
  | 'FOREIGN_LINEAGE'
  | 'ILLEGAL_PARENT_STATE'
  | 'ACTIVE_ATTEMPT';

export interface IdeaIngressRefusal {
  readonly refused: true;
  readonly reason: IdeaIngressRefusalReason;
  readonly detail: string;
}

export interface IdeaIngressSuccess {
  readonly imported: true;
  readonly bundleRef: string;
  readonly ideaRef: string;
  /** The CapsuleIngressReceipt evidence ref recorded by factoryRun.importCapsule. */
  readonly ingressReceiptRef: string;
  readonly outcome: Extract<CommandOutcome, { committed: true } | { replayed: true }>;
}

export type IdeaIngressResult = IdeaIngressSuccess | IdeaIngressRefusal;

/** The operator-side lineage binding this database accepts. */
export interface IdeaLineageBinding {
  readonly expectedLineageId: string;
  /** Discovery is the first stage: the bound parent lifecycle is null. */
  readonly expectedParentLifecycleRef: null;
}

const refused = (reason: IdeaIngressRefusalReason, detail: string): IdeaIngressRefusal => ({ refused: true, reason, detail });

/* ------------------------------------------------------------------ */
/* The PUBLIC ingress                                                  */
/* ------------------------------------------------------------------ */

/**
 * The one public ingress of the Discovery workshop: verify the bundle
 * completely, then import it through the FactoryRun sole-writer repository
 * into the fresh database. Check order is frozen (each class fails closed
 * before the next).
 */
export function ingestIdeaBundle(
  session: KernelPersistenceSession,
  bundle: IdeaIntakeBundle,
  intakeBytes: Uint8Array | undefined,
  binding: IdeaLineageBinding,
): IdeaIngressResult {
  // 1. Stale protocol.
  if (bundle.schemaVersion !== IDEA_BUNDLE_PROTOCOL_VERSION) {
    return refused('STALE_PROTOCOL', `bundle protocol ${bundle.schemaVersion} is not the current ${IDEA_BUNDLE_PROTOCOL_VERSION}`);
  }

  // 2. Bundle self-address + idea product address (corrupt bytes).
  const factBody = {
    schemaVersion: bundle.schemaVersion,
    lineage: bundle.lineage,
    parentState: bundle.parentState,
    idea: { ref: bundle.idea.ref, digest: bundle.idea.digest },
    intakeBytesDigest: bundle.intakeBytesDigest,
  };
  if (sha256OfCanonical(factBody) !== bundle.bundleDigest || bundle.bundleRef !== `sha256:${bundle.bundleDigest}`) {
    return refused('BYTES_CORRUPT', 'the bundle self-address does not verify against its canonical facts');
  }
  if (!SHA256_HEX.test(bundle.intakeBytesDigest)) {
    return refused('BYTES_CORRUPT', `intake bytes digest ${bundle.intakeBytesDigest} is not a sha256 hex digest`);
  }
  if (sha256OfCanonical(bundle.idea.value) !== bundle.idea.digest || bundle.idea.ref !== `sha256:${bundle.idea.digest}`) {
    return refused('BYTES_CORRUPT', 'the idea product address does not verify against its canonical content');
  }

  // 3. Intake bytes present.
  if (intakeBytes === undefined || intakeBytes.byteLength === 0) {
    return refused('BYTES_MISSING', 'the operator intake bytes are absent or empty; missing bytes are never fabricated');
  }
  if (sha256OfCanonical([...intakeBytes]) !== bundle.intakeBytesDigest) {
    return refused('BYTES_CORRUPT', 'the intake bytes do not hash to the pinned intakeBytesDigest');
  }

  // 4. The idea product satisfies its installed contract (schema fence).
  const product = validateProduct(bundle.idea.value);
  if ('refused' in product) {
    return refused('MALFORMED_PRODUCT', `idea product ${product.reason}(${product.field}): ${product.detail}`);
  }

  // 5. Foreign lineage (the first stage binds a null parent lifecycle).
  if (bundle.lineage.lineageId !== binding.expectedLineageId) {
    return refused('FOREIGN_LINEAGE', `bundle lineage ${bundle.lineage.lineageId} is not the bound lineage ${binding.expectedLineageId}; foreign-lineage ideas never enter this database`);
  }
  if (bundle.lineage.parentLifecycleRef !== binding.expectedParentLifecycleRef) {
    return refused('FOREIGN_LINEAGE', `bundle parent lifecycle ${String(bundle.lineage.parentLifecycleRef)} is not the bound null parent (the first stage has no producing parent)`);
  }

  // 6. Illegal parent state.
  if (!(IDEA_LEGAL_PARENT_STATES as readonly string[]).includes(bundle.parentState.status)) {
    return refused('ILLEGAL_PARENT_STATE', `producing parent state ${bundle.parentState.status} is not one of ${IDEA_LEGAL_PARENT_STATES.join('|')}; discovery starts only from the operator intake decision`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(bundle.parentState.decisionRef)) {
    return refused('ILLEGAL_PARENT_STATE', `the parent intake decision ${bundle.parentState.decisionRef} is not a content address`);
  }

  // 7. Active attempt in the target world (fresh-run law).
  const world = session.hydrateWorld().world;
  for (const head of world.heads.values()) {
    if (head.aggregate === 'ActivityAttempt' && head.terminal === undefined) {
      return refused('ACTIVE_ATTEMPT', `ActivityAttempt ${head.instanceId} is still live in the target database; idea intake requires a fresh run world`);
    }
  }

  // 8. Import through the FactoryRun sole-writer repository (public commands).
  if (!world.heads.has(FACTORY_INSTANCE)) {
    const bootstrap = session.factoryRun.applyCommand({
      command: 'factoryRun.bootstrap',
      instanceId: FACTORY_INSTANCE,
      expectedRevision: 0,
      idempotencyKey: 'idea-intake:bootstrap',
      evidenceRefs: [bundle.bundleRef],
    });
    if ('refused' in bootstrap) {
      return refused('ILLEGAL_PARENT_STATE', `factoryRun.bootstrap refused: ${bootstrap.reason}: ${bootstrap.detail}`);
    }
  }
  const head = session.factoryRun.loadHead(FACTORY_INSTANCE);
  const outcome = session.factoryRun.applyCommand({
    command: 'factoryRun.importCapsule',
    instanceId: FACTORY_INSTANCE,
    expectedRevision: head === undefined ? 0 : head.revision,
    idempotencyKey: `idea-intake:${bundle.bundleRef}`,
    evidenceRefs: [bundle.bundleRef, bundle.idea.ref, bundle.parentState.decisionRef],
  });
  if ('refused' in outcome) {
    return refused('ILLEGAL_PARENT_STATE', `factoryRun.importCapsule refused: ${outcome.reason}: ${outcome.detail}`);
  }
  const sequence = 'replayed' in outcome ? outcome.originalEventSequence : (outcome.event?.sequence ?? 0);
  return {
    imported: true,
    bundleRef: bundle.bundleRef,
    ideaRef: bundle.idea.ref,
    ingressReceiptRef: `evidence:CapsuleIngressReceipt#${sequence}`,
    outcome,
  };
}
