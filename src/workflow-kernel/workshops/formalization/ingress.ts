/**
 * workflow-kernel/workshops/formalization/ingress.ts - the content-addressed
 * Discovery handoff capsule and its PUBLIC ingress (WP-11F, plan phase EK-8
 * workshop conversion).
 *
 * The Formalization workshop CONSUMES accepted Discovery products: the
 * capsule is the immutable, content-addressed bundle of the Discovery
 * output (certificate, source claims, constraints, unknowns and terminal
 * lifecycle claims). Laws (mirroring the frozen WP-08 capsule check order):
 *   - every sub-artifact digest is RECOMPUTED over its canonical content at
 *     ingress (a declared digest is never trusted);
 *   - the ONLY ingress is ingestDiscoveryHandoff: verify everything, then
 *     import through the FactoryRun sole-writer repository commands
 *     (factoryRun.bootstrap + factoryRun.importCapsule) into the fresh
 *     database - no test or caller may invoke factoryRun.importCapsule
 *     directly for handoff material;
 *   - typed fail-closed refusals, in the frozen check order:
 *       STALE_PROTOCOL, BYTES_CORRUPT, BYTES_MISSING, FOREIGN_LINEAGE,
 *       ILLEGAL_PARENT_STATE, ACTIVE_ATTEMPT;
 *   - the one legal producing parent state is discovery-terminal (the
 *     Discovery lifecycle handed off; this capsule never carries
 *     formalization-stage material).
 *
 * PURITY of verification: the kernel digest rule only. The single mutation
 * surface is the KernelPersistenceSession passed by the focused tests.
 */

import { canonicalJson, sha256OfCanonical } from '../../domain/digest.js';
import type { CommandOutcome } from '../../domain/types.js';
import type { KernelPersistenceSession } from '../../persistence/session.js';

/** Exact protocol identity of the Discovery handoff capsule. */
export const HANDOFF_PROTOCOL_VERSION = 'ek.discovery-handoff-capsule.ek8-wp11f.v1';

/** The one legal producing parent state (Discovery terminal). */
export const HANDOFF_LEGAL_PARENT_STATES = ['discovery-terminal'] as const;
export type HandoffParentStatus = (typeof HANDOFF_LEGAL_PARENT_STATES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* The capsule value                                                   */
/* ------------------------------------------------------------------ */

/** One content-addressed sub-artifact: content + its recomputed digest. */
export interface HandoffArtifact {
  readonly ref: string;
  readonly digest: string;
  readonly content: unknown;
}

/** Lineage binding: which discovery lineage produced this handoff. */
export interface HandoffLineage {
  readonly lineageId: string;
  /** The producing (Discovery) lifecycle reference, never null for legal capsules. */
  readonly parentLifecycleRef: string | null;
}

/** Parent state fact carried inside the capsule (verified, trusted only after digest checks). */
export interface HandoffParentState {
  readonly status: HandoffParentStatus | string;
  readonly terminalProofRef: string;
}

/** The operator-side Discovery facts the capsule is built from. */
export interface DiscoveryHandoffFacts {
  readonly certificate: HandoffArtifact;
  readonly sourceClaims: readonly HandoffArtifact[];
  readonly constraints: readonly HandoffArtifact[];
  readonly unknowns: readonly HandoffArtifact[];
  readonly terminalLifecycleClaims: readonly HandoffArtifact[];
}

/** The sealed, self-addressed Discovery handoff capsule. */
export interface DiscoveryHandoffCapsule {
  readonly schemaVersion: typeof HANDOFF_PROTOCOL_VERSION;
  readonly capsuleRef: string;
  readonly capsuleDigest: string;
  readonly lineage: HandoffLineage;
  readonly parentState: HandoffParentState;
  readonly certificate: HandoffArtifact;
  readonly sourceClaims: readonly HandoffArtifact[];
  readonly constraints: readonly HandoffArtifact[];
  readonly unknowns: readonly HandoffArtifact[];
  readonly terminalLifecycleClaims: readonly HandoffArtifact[];
  readonly packageBytesDigest: string;
}

/** Seal one sub-artifact (digest recomputed over canonical content). */
export function handoffArtifact(content: unknown): HandoffArtifact {
  const digest = sha256OfCanonical(content);
  return { ref: `sha256:${digest}`, digest, content };
}

function stripContent(artifact: HandoffArtifact): Omit<HandoffArtifact, 'content'> {
  return { ref: artifact.ref, digest: artifact.digest };
}

/** Build the sealed capsule; capsuleRef is DERIVED from the canonical facts. */
export function buildDiscoveryHandoffCapsule(
  facts: DiscoveryHandoffFacts,
  lineage: HandoffLineage,
  parentState: HandoffParentState,
  packageBytes: Uint8Array,
): DiscoveryHandoffCapsule {
  const packageBytesDigest = sha256OfCanonical([...packageBytes]);
  const body = {
    schemaVersion: HANDOFF_PROTOCOL_VERSION,
    lineage,
    parentState,
    certificate: stripContent(facts.certificate),
    sourceClaims: facts.sourceClaims.map(stripContent),
    constraints: facts.constraints.map(stripContent),
    unknowns: facts.unknowns.map(stripContent),
    terminalLifecycleClaims: facts.terminalLifecycleClaims.map(stripContent),
    packageBytesDigest,
  } as const;
  const capsuleDigest = sha256OfCanonical(body);
  return {
    ...body,
    certificate: facts.certificate,
    sourceClaims: [...facts.sourceClaims],
    constraints: [...facts.constraints],
    unknowns: [...facts.unknowns],
    terminalLifecycleClaims: [...facts.terminalLifecycleClaims],
    capsuleRef: `sha256:${capsuleDigest}`,
    capsuleDigest,
  };
}

/* ------------------------------------------------------------------ */
/* Typed ingress refusals (closed set)                                 */
/* ------------------------------------------------------------------ */

export type HandoffIngressRefusalReason =
  | 'STALE_PROTOCOL'
  | 'BYTES_CORRUPT'
  | 'BYTES_MISSING'
  | 'FOREIGN_LINEAGE'
  | 'ILLEGAL_PARENT_STATE'
  | 'ACTIVE_ATTEMPT';

export interface HandoffIngressRefusal {
  readonly refused: true;
  readonly reason: HandoffIngressRefusalReason;
  readonly detail: string;
}

export interface HandoffIngressSuccess {
  readonly imported: true;
  readonly capsuleRef: string;
  readonly verified: {
    readonly capsuleDigest: string;
    readonly certificateDigest: string;
    readonly sourceClaimDigests: readonly string[];
    readonly constraintDigests: readonly string[];
    readonly unknownDigests: readonly string[];
    readonly terminalClaimDigests: readonly string[];
    readonly packageBytesDigest: string;
  };
  /** The CapsuleIngressReceipt evidence ref recorded by factoryRun.importCapsule. */
  readonly ingressReceiptRef: string;
  readonly outcome: Extract<CommandOutcome, { committed: true } | { replayed: true }>;
}

export type HandoffIngressResult = HandoffIngressSuccess | HandoffIngressRefusal;

/** The lineage binding the operator expects this database to accept. */
export interface HandoffLineageBinding {
  readonly expectedLineageId: string;
  readonly expectedParentLifecycleRef: string | null;
}

/* ------------------------------------------------------------------ */
/* The PUBLIC ingress                                                  */
/* ------------------------------------------------------------------ */

const FACTORY_INSTANCE = 'factory-run:1';

function refused(reason: HandoffIngressRefusalReason, detail: string): HandoffIngressRefusal {
  return { refused: true, reason, detail };
}

/**
 * The one public ingress: verify the capsule completely, then import it
 * through the FactoryRun sole-writer repository into the fresh database.
 * Check order is frozen (each class fails closed before the next).
 */
export function ingestDiscoveryHandoff(
  session: KernelPersistenceSession,
  capsule: DiscoveryHandoffCapsule,
  packageBytes: Uint8Array | undefined,
  binding: HandoffLineageBinding,
): HandoffIngressResult {
  // 1. Stale protocol.
  if (capsule.schemaVersion !== HANDOFF_PROTOCOL_VERSION) {
    return refused('STALE_PROTOCOL', `handoff protocol ${capsule.schemaVersion} is not the current ${HANDOFF_PROTOCOL_VERSION}; stale-protocol capsules are refused at ingress`);
  }

  // 2. Capsule self-address (corrupt capsule bytes).
  const artifacts: readonly [string, HandoffArtifact][] = [
    ['certificate', capsule.certificate],
    ...capsule.sourceClaims.map((artifact, index): [string, HandoffArtifact] => [`sourceClaims[${index}]`, artifact]),
    ...capsule.constraints.map((artifact, index): [string, HandoffArtifact] => [`constraints[${index}]`, artifact]),
    ...capsule.unknowns.map((artifact, index): [string, HandoffArtifact] => [`unknowns[${index}]`, artifact]),
    ...capsule.terminalLifecycleClaims.map((artifact, index): [string, HandoffArtifact] => [`terminalLifecycleClaims[${index}]`, artifact]),
  ];
  const factBody = {
    schemaVersion: capsule.schemaVersion,
    lineage: capsule.lineage,
    parentState: capsule.parentState,
    certificate: stripContent(capsule.certificate),
    sourceClaims: capsule.sourceClaims.map(stripContent),
    constraints: capsule.constraints.map(stripContent),
    unknowns: capsule.unknowns.map(stripContent),
    terminalLifecycleClaims: capsule.terminalLifecycleClaims.map(stripContent),
    packageBytesDigest: capsule.packageBytesDigest,
  };
  if (sha256OfCanonical(factBody) !== capsule.capsuleDigest || capsule.capsuleRef !== `sha256:${capsule.capsuleDigest}`) {
    return refused('BYTES_CORRUPT', 'the capsule self-address does not verify against its canonical facts (corrupt capsule bytes)');
  }
  if (!SHA256_HEX.test(capsule.packageBytesDigest)) {
    return refused('BYTES_CORRUPT', `package bytes digest ${capsule.packageBytesDigest} is not a sha256 hex digest`);
  }

  // 3. Package bytes present.
  if (packageBytes === undefined || packageBytes.byteLength === 0) {
    return refused('BYTES_MISSING', 'the capsule package bytes are absent or empty; missing bytes are refused, never fabricated');
  }

  // 4. Every sub-artifact digest recomputed over its canonical content.
  for (const [label, artifact] of artifacts) {
    if (!SHA256_HEX.test(artifact.digest) || artifact.ref !== `sha256:${artifact.digest}`) {
      return refused('BYTES_CORRUPT', `capsule artifact ${label} ref ${artifact.ref} is not the content address of digest ${artifact.digest}`);
    }
    const recomputed = sha256OfCanonical(artifact.content);
    if (recomputed !== artifact.digest) {
      return refused('BYTES_CORRUPT', `capsule artifact ${label} digest ${artifact.digest} does not verify (recomputed ${recomputed})`);
    }
  }
  if (capsule.sourceClaims.length === 0 || capsule.terminalLifecycleClaims.length === 0) {
    return refused('BYTES_CORRUPT', 'capsule source claims and terminal lifecycle claims must each be non-empty (a capsule without material facts is corrupt)');
  }
  const bytesDigest = sha256OfCanonical([...packageBytes]);
  if (bytesDigest !== capsule.packageBytesDigest) {
    return refused('BYTES_CORRUPT', `package bytes hash ${bytesDigest} != pinned packageBytesDigest ${capsule.packageBytesDigest} (corrupt package bytes)`);
  }

  // 5. Foreign lineage.
  if (capsule.lineage.lineageId !== binding.expectedLineageId) {
    return refused('FOREIGN_LINEAGE', `capsule lineage ${capsule.lineage.lineageId} is not the bound lineage ${binding.expectedLineageId}; foreign-lineage capsules never enter this database`);
  }
  if ((capsule.lineage.parentLifecycleRef ?? null) !== (binding.expectedParentLifecycleRef ?? null)) {
    return refused('FOREIGN_LINEAGE', `capsule parent lifecycle ${String(capsule.lineage.parentLifecycleRef)} is not the bound parent ${String(binding.expectedParentLifecycleRef)}`);
  }

  // 6. Illegal parent state.
  if (!(HANDOFF_LEGAL_PARENT_STATES as readonly string[]).includes(capsule.parentState.status)) {
    return refused('ILLEGAL_PARENT_STATE', `producing parent state ${capsule.parentState.status} is not one of ${HANDOFF_LEGAL_PARENT_STATES.join('|')}; a non-terminal Discovery parent cannot hand off a capsule`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(capsule.parentState.terminalProofRef)) {
    return refused('ILLEGAL_PARENT_STATE', `parent terminal proof ${capsule.parentState.terminalProofRef} is not a content address`);
  }

  // 7. Active attempt in the target world (fresh-run law).
  const world = session.hydrateWorld().world;
  for (const head of world.heads.values()) {
    if (head.aggregate === 'ActivityAttempt' && head.terminal === undefined) {
      return refused('ACTIVE_ATTEMPT', `ActivityAttempt ${head.instanceId} is still live in the target database; capsule ingress requires a fresh run world`);
    }
  }

  // 8. Import through the FactoryRun sole-writer repository (public commands).
  if (!world.heads.has(FACTORY_INSTANCE)) {
    const bootstrap = session.factoryRun.applyCommand({
      command: 'factoryRun.bootstrap',
      instanceId: FACTORY_INSTANCE,
      expectedRevision: 0,
      idempotencyKey: 'handoff-ingress:bootstrap',
      evidenceRefs: [capsule.capsuleRef],
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
    idempotencyKey: `handoff-ingress:${capsule.capsuleRef}`,
    evidenceRefs: [
      capsule.capsuleRef,
      capsule.certificate.ref,
      ...capsule.sourceClaims.map((artifact) => artifact.ref),
      ...capsule.terminalLifecycleClaims.map((artifact) => artifact.ref),
    ],
  });
  if ('refused' in outcome) {
    return refused('ILLEGAL_PARENT_STATE', `factoryRun.importCapsule refused: ${outcome.reason}: ${outcome.detail}`);
  }
  const sequence = 'replayed' in outcome ? outcome.originalEventSequence : (outcome.event?.sequence ?? 0);
  return {
    imported: true,
    capsuleRef: capsule.capsuleRef,
    verified: {
      capsuleDigest: capsule.capsuleDigest,
      certificateDigest: capsule.certificate.digest,
      sourceClaimDigests: capsule.sourceClaims.map((artifact) => artifact.digest),
      constraintDigests: capsule.constraints.map((artifact) => artifact.digest),
      unknownDigests: capsule.unknowns.map((artifact) => artifact.digest),
      terminalClaimDigests: capsule.terminalLifecycleClaims.map((artifact) => artifact.digest),
      packageBytesDigest: capsule.packageBytesDigest,
    },
    ingressReceiptRef: `evidence:CapsuleIngressReceipt#${sequence}`,
    outcome,
  };
}

/** Canonical JSON of the capsule facts (fixture writer / test oracle). */
export function handoffFactsJson(capsule: DiscoveryHandoffCapsule): string {
  return canonicalJson({
    capsuleRef: capsule.capsuleRef,
    capsuleDigest: capsule.capsuleDigest,
    lineage: capsule.lineage,
    certificate: capsule.certificate.digest,
    sourceClaims: capsule.sourceClaims.map((artifact) => artifact.digest),
    constraints: capsule.constraints.map((artifact) => artifact.digest),
    unknowns: capsule.unknowns.map((artifact) => artifact.digest),
    terminalLifecycleClaims: capsule.terminalLifecycleClaims.map((artifact) => artifact.digest),
    packageBytesDigest: capsule.packageBytesDigest,
  });
}
