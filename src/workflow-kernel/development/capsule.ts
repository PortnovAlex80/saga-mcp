/**
 * workflow-kernel/development/capsule.ts - the content-addressed
 * Discovery+Formalization capsule and its PUBLIC ingress (WP-08, plan phase
 * EK-5).
 *
 * Laws implemented here (plan EK-5 "capsule ingress"):
 *   - A capsule is a content-addressed immutable bundle of the
 *     Discovery+Formalization output: certificate, requirements, terminal
 *     claims, AC set, module package, build output and base repository
 *     digests. Every sub-artifact digest is recomputed over its canonical
 *     content at ingress (never trusted as declared).
 *   - The ONLY ingress is `ingestCapsule`: verify everything, then import
 *     through the FactoryRun sole-writer repository commands
 *     (factoryRun.bootstrap + factoryRun.importCapsule) into the fresh
 *     database. No test or caller may invoke factoryRun.importCapsule
 *     directly for capsule material.
 *   - Typed fail-closed refusals, in the frozen check order:
 *       STALE_PROTOCOL       capsule schema/protocol version is not the
 *                            current one;
 *       BYTES_CORRUPT        any verified digest mismatch (capsule
 *                            self-address or any sub-artifact) or package
 *                            bytes that do not hash to the pinned digest;
 *       BYTES_MISSING        package bytes absent/empty;
 *       FOREIGN_LINEAGE      capsule lineage does not match the operator's
 *                            expected lineage binding;
 *       ILLEGAL_PARENT_STATE the producing parent lifecycle is not
 *                            formalization-terminal;
 *       ACTIVE_ATTEMPT       the target database already holds a live
 *                            (nonterminal) ActivityAttempt - a capsule may
 *                            never be imported into an active run world.
 *   - PURITY of verification: node:crypto digests + the pure domain digest
 *     rule only. The single mutation surface is the KernelPersistenceSession
 *     passed by the focused tests.
 */

import { canonicalJson, sha256OfCanonical } from '../domain/digest.js';
import type { CommandOutcome } from '../domain/types.js';
import type { KernelPersistenceSession } from '../persistence/session.js';

/** Exact protocol identity of the Discovery+Formalization capsule. */
export const CAPSULE_PROTOCOL_VERSION = 'ek.discovery-formalization-capsule.ek5.v1';

/** The one legal producing parent state (Discovery+Formalization terminal). */
export const CAPSULE_LEGAL_PARENT_STATES = ['formalization-terminal'] as const;
export type CapsuleParentStatus = (typeof CAPSULE_LEGAL_PARENT_STATES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/* The capsule value                                                   */
/* ------------------------------------------------------------------ */

/** One content-addressed sub-artifact: content + its recomputed digest. */
export interface CapsuleArtifact {
  /** Content address ("sha256:" + 64 hex) over the canonical content. */
  readonly ref: string;
  readonly digest: string;
  readonly content: unknown;
}

/** Lineage binding: which factory lineage produced this capsule. */
export interface CapsuleLineage {
  readonly lineageId: string;
  /** The producing (formalization) lifecycle reference, never null for legal capsules. */
  readonly parentLifecycleRef: string | null;
}

/** Parent state fact carried inside the capsule (verified, then trusted only after digest check). */
export interface CapsuleParentState {
  readonly status: CapsuleParentStatus | string;
  readonly terminalProofRef: string;
}

/** The operator-side facts a capsule is built from. */
export interface CapsuleFacts {
  readonly certificate: CapsuleArtifact;
  readonly requirements: readonly CapsuleArtifact[];
  readonly terminalClaims: readonly CapsuleArtifact[];
  readonly acceptanceCriteria: readonly CapsuleArtifact[];
  readonly modulePackage: CapsuleArtifact;
  /** Digest over the module package build output. */
  readonly buildOutput: CapsuleArtifact;
  /** Baseline repository hash (D0 handoff). */
  readonly baseRepository: CapsuleArtifact;
}

/** The sealed, self-addressed Discovery+Formalization capsule. */
export interface DiscoveryFormalizationCapsule {
  readonly schemaVersion: typeof CAPSULE_PROTOCOL_VERSION;
  readonly capsuleRef: string;
  readonly capsuleDigest: string;
  readonly lineage: CapsuleLineage;
  readonly parentState: CapsuleParentState;
  readonly certificate: CapsuleArtifact;
  readonly requirements: readonly CapsuleArtifact[];
  readonly terminalClaims: readonly CapsuleArtifact[];
  readonly acceptanceCriteria: readonly CapsuleArtifact[];
  readonly modulePackage: CapsuleArtifact;
  readonly buildOutput: CapsuleArtifact;
  readonly baseRepository: CapsuleArtifact;
  /** sha256 (hex) over the exact package bytes. */
  readonly packageBytesDigest: string;
}

/** Helper: seal one artifact (digest recomputed over canonical content). */
export function capsuleArtifact(content: unknown): CapsuleArtifact {
  const digest = sha256OfCanonical(content);
  return { ref: `sha256:${digest}`, digest, content };
}

/**
 * Build the sealed capsule. The capsule digest covers the canonical facts
 * (lineage, parent state, every sub-artifact digest and the package bytes
 * digest) minus the self-referencing keys; capsuleRef is DERIVED.
 */
export function buildCapsule(
  facts: CapsuleFacts,
  lineage: CapsuleLineage,
  parentState: CapsuleParentState,
  packageBytes: Uint8Array,
): DiscoveryFormalizationCapsule {
  const packageBytesDigest = sha256OfCanonical([...packageBytes]);
  const body = {
    schemaVersion: CAPSULE_PROTOCOL_VERSION,
    lineage,
    parentState,
    certificate: stripContent(facts.certificate),
    requirements: facts.requirements.map(stripContent),
    terminalClaims: facts.terminalClaims.map(stripContent),
    acceptanceCriteria: facts.acceptanceCriteria.map(stripContent),
    modulePackage: stripContent(facts.modulePackage),
    buildOutput: stripContent(facts.buildOutput),
    baseRepository: stripContent(facts.baseRepository),
    packageBytesDigest,
  } as const;
  const capsuleDigest = sha256OfCanonical(body);
  return {
    ...body,
    schemaVersion: CAPSULE_PROTOCOL_VERSION,
    certificate: facts.certificate,
    requirements: [...facts.requirements],
    terminalClaims: [...facts.terminalClaims],
    acceptanceCriteria: [...facts.acceptanceCriteria],
    modulePackage: facts.modulePackage,
    buildOutput: facts.buildOutput,
    baseRepository: facts.baseRepository,
    capsuleRef: `sha256:${capsuleDigest}`,
    capsuleDigest,
  };
}

function stripContent(artifact: CapsuleArtifact): Omit<CapsuleArtifact, 'content'> {
  return { ref: artifact.ref, digest: artifact.digest };
}

/* ------------------------------------------------------------------ */
/* Typed ingress refusals (closed set)                                 */
/* ------------------------------------------------------------------ */

export type CapsuleIngressRefusalReason =
  | 'STALE_PROTOCOL'
  | 'BYTES_CORRUPT'
  | 'BYTES_MISSING'
  | 'FOREIGN_LINEAGE'
  | 'ILLEGAL_PARENT_STATE'
  | 'ACTIVE_ATTEMPT';

export interface CapsuleIngressRefusal {
  readonly refused: true;
  readonly reason: CapsuleIngressRefusalReason;
  readonly detail: string;
}

/** What ingress verified and what the kernel committed. */
export interface CapsuleIngressSuccess {
  readonly imported: true;
  readonly capsuleRef: string;
  readonly verified: {
    readonly capsuleDigest: string;
    readonly certificateDigest: string;
    readonly requirementDigests: readonly string[];
    readonly terminalClaimDigests: readonly string[];
    readonly acceptanceCriteriaDigests: readonly string[];
    readonly modulePackageDigest: string;
    readonly buildDigest: string;
    readonly baseRepositoryDigest: string;
    readonly packageBytesDigest: string;
  };
  /** The CapsuleIngressReceipt evidence ref recorded by factoryRun.importCapsule. */
  readonly ingressReceiptRef: string;
  readonly outcome: Extract<CommandOutcome, { committed: true } | { replayed: true }>;
}

export type CapsuleIngressResult = CapsuleIngressSuccess | CapsuleIngressRefusal;

/** The lineage binding the operator expects this database to accept. */
export interface CapsuleLineageBinding {
  readonly expectedLineageId: string;
  /** The producing lifecycle this database was created for. */
  readonly expectedParentLifecycleRef: string | null;
}

/* ------------------------------------------------------------------ */
/* The PUBLIC ingress                                                  */
/* ------------------------------------------------------------------ */

const FACTORY_INSTANCE = 'factory-run:1';

/**
 * The one public ingress: verify the capsule completely, then import it
 * through the FactoryRun sole-writer repository into the fresh database.
 * Check order is frozen (each class fails closed before the next).
 */
export function ingestCapsule(
  session: KernelPersistenceSession,
  capsule: DiscoveryFormalizationCapsule,
  packageBytes: Uint8Array | undefined,
  binding: CapsuleLineageBinding,
): CapsuleIngressResult {
  // 1. Stale protocol.
  if (capsule.schemaVersion !== CAPSULE_PROTOCOL_VERSION) {
    return refused('STALE_PROTOCOL', `capsule protocol ${capsule.schemaVersion} is not the current ${CAPSULE_PROTOCOL_VERSION}; stale-protocol capsules are refused at ingress`);
  }

  // 2. Capsule self-address (corrupt capsule bytes).
  const artifacts: readonly [string, CapsuleArtifact][] = [
    ['certificate', capsule.certificate],
    ['modulePackage', capsule.modulePackage],
    ['buildOutput', capsule.buildOutput],
    ['baseRepository', capsule.baseRepository],
    ...capsule.requirements.map((artifact, index): [string, CapsuleArtifact] => [`requirements[${index}]`, artifact]),
    ...capsule.terminalClaims.map((artifact, index): [string, CapsuleArtifact] => [`terminalClaims[${index}]`, artifact]),
    ...capsule.acceptanceCriteria.map((artifact, index): [string, CapsuleArtifact] => [`acceptanceCriteria[${index}]`, artifact]),
  ];
  const factBody = {
    schemaVersion: capsule.schemaVersion,
    lineage: capsule.lineage,
    parentState: capsule.parentState,
    certificate: stripContent(capsule.certificate),
    requirements: capsule.requirements.map(stripContent),
    terminalClaims: capsule.terminalClaims.map(stripContent),
    acceptanceCriteria: capsule.acceptanceCriteria.map(stripContent),
    modulePackage: stripContent(capsule.modulePackage),
    buildOutput: stripContent(capsule.buildOutput),
    baseRepository: stripContent(capsule.baseRepository),
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
  if (capsule.requirements.length === 0 || capsule.terminalClaims.length === 0 || capsule.acceptanceCriteria.length === 0) {
    return refused('BYTES_CORRUPT', 'capsule requirements, terminal claims and AC set must each be non-empty (a capsule without material facts is corrupt)');
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
  if (!(CAPSULE_LEGAL_PARENT_STATES as readonly string[]).includes(capsule.parentState.status)) {
    return refused('ILLEGAL_PARENT_STATE', `producing parent state ${capsule.parentState.status} is not one of ${CAPSULE_LEGAL_PARENT_STATES.join('|')}; a non-terminal formalization parent cannot hand off a capsule`);
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
      idempotencyKey: 'capsule-ingress:bootstrap',
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
    idempotencyKey: `capsule-ingress:${capsule.capsuleRef}`,
    evidenceRefs: [
      capsule.capsuleRef,
      capsule.certificate.ref,
      capsule.modulePackage.ref,
      capsule.buildOutput.ref,
      capsule.baseRepository.ref,
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
      requirementDigests: capsule.requirements.map((artifact) => artifact.digest),
      terminalClaimDigests: capsule.terminalClaims.map((artifact) => artifact.digest),
      acceptanceCriteriaDigests: capsule.acceptanceCriteria.map((artifact) => artifact.digest),
      modulePackageDigest: capsule.modulePackage.digest,
      buildDigest: capsule.buildOutput.digest,
      baseRepositoryDigest: capsule.baseRepository.digest,
      packageBytesDigest: capsule.packageBytesDigest,
    },
    ingressReceiptRef: `evidence:CapsuleIngressReceipt#${sequence}`,
    outcome,
  };
}

/** Typed refusal constructor (the closed ingress vocabulary). */
function refused(reason: CapsuleIngressRefusalReason, detail: string): CapsuleIngressRefusal {
  return { refused: true, reason, detail };
}

/** Canonical JSON of the capsule facts (fixture writer / test oracle). */
export function capsuleFactsJson(capsule: DiscoveryFormalizationCapsule): string {
  return canonicalJson({
    capsuleRef: capsule.capsuleRef,
    capsuleDigest: capsule.capsuleDigest,
    lineage: capsule.lineage,
    certificate: capsule.certificate.digest,
    requirements: capsule.requirements.map((artifact) => artifact.digest),
    terminalClaims: capsule.terminalClaims.map((artifact) => artifact.digest),
    acceptanceCriteria: capsule.acceptanceCriteria.map((artifact) => artifact.digest),
    modulePackage: capsule.modulePackage.digest,
    buildOutput: capsule.buildOutput.digest,
    baseRepository: capsule.baseRepository.digest,
    packageBytesDigest: capsule.packageBytesDigest,
  });
}
