// src/process-modules/application/workshop-capability-manifest.ts
//
// ADR-053 Phase 1 — single executable Workshop capability manifest.
//
// PROBLEM (ADR-053-CUTOVER-TODO Phase 1): payload contracts, check providers
// and post-acceptance effects were installed through three separate
// process-global registries, and the worker MCP process hand-listed its four
// payload contracts in src/index.ts independently of the orchestrator's module
// registrations. Adding a contract to a module required manually editing the
// worker-MCP hand-list; forgetting to do so left the worker process unable to
// decode a payload the orchestrator had pinned into a durable WorkIntent
// (exactly the LIVE-REVIEW-004 class of defect).
//
// FIX: one declarative `WorkshopCapabilityManifest` is the single source of
// truth for the payload contracts BOTH processes install. The orchestrator and
// the worker MCP both call `installWorkshopPayloadContracts()`, which iterates
// `WORKSHOP_PAYLOAD_CONTRACTS`. There is no hand-list to drift. The manifest
// digest is computed deterministically and exposed so a startup binding check
// can detect build/registration drift between processes.
//
// Check providers and post-acceptance effects are orchestrator-internal (the
// worker MCP never runs gates or effects), so they have no cross-process drift
// risk. They are declared in the manifest for audit completeness and future
// expansion, but cross-process parity is enforced only for payload contracts.
//
// ARCHITECTURE RATCHET: after this cutover, NO production code may call
// `registerProductPayloadContract` directly except inside
// `installWorkshopPayloadContracts` below. The test
// tests/architecture/workshop-manifest-parity.test.mjs enforces this.

import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type { SqlDatabasePort } from '../../application/ports/sql-database.js';
import type { ProductPayloadContract } from './product-payload-contract.js';
import {
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID,
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
  developmentImplementationPayloadContract,
  developmentReadinessManifestPayloadContract,
  developmentReviewVerdictPayloadContract,
  developmentTaskGraphPayloadContract,
  developmentVerificationPayloadContract,
  sourceChangeCandidatePayloadContract,
} from '../../modules/development/application/development-check-providers.js';
import {
  ACCESSIBLE_COUNTER_CHECK_PROVIDER_DIGEST,
  ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID,
  ACCESSIBLE_COUNTER_CHECK_PROVIDER_VERSION,
  AUTHORIZED_OBSERVER_CHECK_PROVIDER_DIGEST,
  AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID,
  AUTHORIZED_OBSERVER_CHECK_PROVIDER_VERSION,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../modules/development/application/candidate-check-contracts.js';
import {
  DISCOVERY_PROPOSAL_CHECK_PROVIDER_DIGEST,
  DISCOVERY_PROPOSAL_CHECK_PROVIDER_ID,
  DISCOVERY_PROPOSAL_CHECK_PROVIDER_VERSION,
  DISCOVERY_READINESS_CHECK_PROVIDER_DIGEST,
  DISCOVERY_READINESS_CHECK_PROVIDER_ID,
  DISCOVERY_READINESS_CHECK_PROVIDER_VERSION,
} from '../../modules/discovery/application/discovery-check-providers.js';
import { FORMALIZATION_CHECK_REFS } from '../../modules/formalization/application/formalization-check-refs.js';
import {
  factoryReviewVerdictPayloadContract,
  REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
  REVIEW_VERDICT_CHECK_PROVIDER_ID,
  REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
} from './review-verdict-check-provider.js';
import {
  registerProductPayloadContract,
  snapshotProductPayloadContracts,
} from './product-payload-contract.js';
import {
  PRODUCT_CONTRACT_CHECK_PROVIDER_DIGEST,
  PRODUCT_CONTRACT_CHECK_PROVIDER_ID,
  PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION,
  createStandardCheckProviderRegistry,
  registerFactoryCheckProvider,
} from './standard-check-providers.js';
import type { CheckProvider } from '../domain/workplace/gate.js';
import {
  registerFactoryPostAcceptanceEffect,
  createPostAcceptanceEffectRegistry,
  type PostAcceptanceEffect,
} from './post-acceptance-effects.js';
import {
  GIT_INTEGRATION_EFFECT_DIGEST,
  GIT_INTEGRATION_EFFECT_ID,
  GIT_INTEGRATION_EFFECT_VERSION,
} from '../../infrastructure/workplace/git-integration-effect.js';
import {
  REPLAY_CAPTURE_EFFECT_DIGEST,
  REPLAY_CAPTURE_EFFECT_ID,
  REPLAY_CAPTURE_EFFECT_VERSION,
} from '../../infrastructure/replay/replay-capture-effect.js';
import {
  FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_DIGEST,
  FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
  FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_VERSION,
} from '../../modules/formalization/application/formalization-accept-products-effect.js';

// ---------------------------------------------------------------------------
// Manifest identity.
//
// `WORKSHOP_ID` identifies this workshop across processes. `WORKSHOP_EPOCH` is
// bumped when the capability set intentionally changes (a contract is added,
// removed, or its digest changes). The digest captures the exact capability
// set, so the epoch is a human-readable coarse version; the digest is the
// precise binding.
// ---------------------------------------------------------------------------
const WORKSHOP_ID = 'saga-factory';
const WORKSHOP_EPOCH = '2026-08-11-adr-053-phase-1';

// ---------------------------------------------------------------------------
// THE single source of truth for payload contracts installed in EVERY process.
//
// Order is canonical (sorted by schemaId for the digest; the array order here
// is human-organised by owner). Adding a contract here automatically registers
// it in both the orchestrator and the worker MCP. Removing one removes it from
// both. There is no second hand-list.
// ---------------------------------------------------------------------------
export const WORKSHOP_PAYLOAD_CONTRACTS: readonly ProductPayloadContract[] = [
  // --- development module ---
  developmentVerificationPayloadContract,
  developmentReviewVerdictPayloadContract,
  developmentTaskGraphPayloadContract,
  // P1 of the desync map: the two implementation products previously had NO
  // payload contract — their shapes lived only in untyped consumer casts and
  // skill prose. Pinning the consumer read surface here installs the contract
  // in BOTH the orchestrator and the worker MCP with no hand-list to drift.
  developmentImplementationPayloadContract,
  developmentReadinessManifestPayloadContract,
  sourceChangeCandidatePayloadContract,
  // --- cross-cutting (review verdict used by development + formalization) ---
  factoryReviewVerdictPayloadContract,
];

// ---------------------------------------------------------------------------
// Manifest types.
//
// `PayloadContractManifestEntry` is serialisable data derived from a contract
// object — it carries the declarative identity (schemaId / contractId /
// version / contractDigest / owner) without the executable `validate` fn. The
// digest is computed over these entries so two processes running the same code
// produce the same digest by construction; drift is detectable.
// ---------------------------------------------------------------------------
export interface PayloadContractManifestEntry {
  readonly schemaId: string;
  readonly contractId: string;
  readonly version: string;
  readonly contractDigest: string;
  readonly owner: string;
}

export interface WorkshopCapabilityManifest {
  readonly workshopId: string;
  readonly epoch: string;
  readonly payloadContracts: readonly PayloadContractManifestEntry[];
  readonly payloadContractCount: number;
  readonly executableCapabilities: readonly ExecutableCapabilityManifestEntry[];
  readonly executableCapabilityCount: number;
  readonly manifestDigest: string;
}

export interface ExecutableCapabilityManifestEntry {
  readonly kind: 'check-provider' | 'post-acceptance-effect' | 'transition-handler';
  readonly logicalId: string;
  readonly version: string;
  readonly implementationDigest: string;
  readonly roles: readonly ('orchestrator' | 'worker-mcp' | 'scripted-worker')[];
}

const orchestratorOnly = ['orchestrator'] as const;
export type WorkshopProcessRole = 'orchestrator' | 'worker-mcp' | 'scripted-worker';
const checkProvider = (
  logicalId: string, version: string, implementationDigest: string,
): ExecutableCapabilityManifestEntry => ({
  kind: 'check-provider', logicalId, version, implementationDigest,
  roles: orchestratorOnly,
});
const effect = (
  logicalId: string, version: string, implementationDigest: string,
): ExecutableCapabilityManifestEntry => ({
  kind: 'post-acceptance-effect', logicalId, version, implementationDigest,
  roles: orchestratorOnly,
});

export const WORKSHOP_EXECUTABLE_CAPABILITIES: readonly ExecutableCapabilityManifestEntry[] = [
  checkProvider(PRODUCT_CONTRACT_CHECK_PROVIDER_ID, PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION, PRODUCT_CONTRACT_CHECK_PROVIDER_DIGEST),
  checkProvider(REVIEW_VERDICT_CHECK_PROVIDER_ID, REVIEW_VERDICT_CHECK_PROVIDER_VERSION, REVIEW_VERDICT_CHECK_PROVIDER_DIGEST),
  checkProvider(DISCOVERY_PROPOSAL_CHECK_PROVIDER_ID, DISCOVERY_PROPOSAL_CHECK_PROVIDER_VERSION, DISCOVERY_PROPOSAL_CHECK_PROVIDER_DIGEST),
  checkProvider(DISCOVERY_READINESS_CHECK_PROVIDER_ID, DISCOVERY_READINESS_CHECK_PROVIDER_VERSION, DISCOVERY_READINESS_CHECK_PROVIDER_DIGEST),
  checkProvider(DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID, DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION, DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST),
  checkProvider(DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID, DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION, DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_DIGEST),
  checkProvider(DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID, DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION, DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST),
  checkProvider(LOCAL_RUNNABILITY_CHECK_PROVIDER_ID, LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION, LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST),
  checkProvider(ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID, ACCESSIBLE_COUNTER_CHECK_PROVIDER_VERSION, ACCESSIBLE_COUNTER_CHECK_PROVIDER_DIGEST),
  checkProvider(AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID, AUTHORIZED_OBSERVER_CHECK_PROVIDER_VERSION, AUTHORIZED_OBSERVER_CHECK_PROVIDER_DIGEST),
  ...Object.values(FORMALIZATION_CHECK_REFS).map(ref =>
    checkProvider(ref.providerId, ref.version, ref.providerDigest)),
  effect(GIT_INTEGRATION_EFFECT_ID, GIT_INTEGRATION_EFFECT_VERSION, GIT_INTEGRATION_EFFECT_DIGEST),
  effect(REPLAY_CAPTURE_EFFECT_ID, REPLAY_CAPTURE_EFFECT_VERSION, REPLAY_CAPTURE_EFFECT_DIGEST),
  effect(FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID, FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_VERSION, FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_DIGEST),
  ...[
    ['close-presentation', 'presentation-closure'],
    ['run-gate', 'gate-run-driver'],
    ['run-effects', 'production-cell-node-executor'],
    ['record-final-acceptance', 'production-cell-node-executor'],
    ['settle-process', 'production-cell-node-executor'],
    ['route-lifecycle', 'lifecycle-orchestrator'],
  ].map(([logicalId, owner]) => ({
    kind: 'transition-handler' as const,
    logicalId: logicalId!,
    version: '1.0.0',
    implementationDigest: sha256Hex({ logicalId, owner, protocol: 'factory-transition-obligation.v1' }),
    roles: orchestratorOnly,
  })),
];

export interface WorkshopResolvedBinding {
  readonly kind: 'payload-contract' | ExecutableCapabilityManifestEntry['kind'];
  readonly logicalId: string;
  readonly version: string;
  readonly implementationDigest: string;
}

const resolvedTransitionHandlers = new Map<string, WorkshopResolvedBinding>();

// Owner map: which workshop module contributes each payload contract. This is
// declarative metadata for audit; it does not affect registration (every
// process installs every contract in WORKSHOP_PAYLOAD_CONTRACTS).
const PAYLOAD_CONTRACT_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  [developmentVerificationPayloadContract.schemaId]: 'development',
  [developmentReviewVerdictPayloadContract.schemaId]: 'development',
  [developmentTaskGraphPayloadContract.schemaId]: 'development',
  [factoryReviewVerdictPayloadContract.schemaId]: 'formalization',
});

/**
 * Derive a serialisable manifest entry from a payload contract object. The
 * entry excludes the executable `validate` fn so the manifest is pure data
 * and its digest is stable across serialisation.
 */
function payloadContractEntry(
  contract: ProductPayloadContract,
): PayloadContractManifestEntry {
  return {
    schemaId: contract.schemaId,
    contractId: contract.contractId,
    version: contract.version,
    contractDigest: contract.contractDigest,
    owner: PAYLOAD_CONTRACT_OWNERS[contract.schemaId] ?? 'unknown',
  };
}

/**
 * Build the canonical workshop capability manifest from the single source of
 * truth (`WORKSHOP_PAYLOAD_CONTRACTS`). Deterministic: the payload-contract
 * entries are sorted by schemaId before digesting, so array-order changes do
 * not change the digest.
 *
 * This is the ONLY constructor for a `WorkshopCapabilityManifest`. Both the
 * orchestrator and the worker MCP call it (transitively via
 * `getWorkshopManifestDigest` / `installWorkshopPayloadContracts`) and must
 * observe the same digest.
 */
export function buildWorkshopCapabilityManifest(): WorkshopCapabilityManifest {
  const payloadContracts = [...WORKSHOP_PAYLOAD_CONTRACTS]
    .map(payloadContractEntry)
    .sort((a, b) => (a.schemaId < b.schemaId ? -1 : a.schemaId > b.schemaId ? 1 : 0));
  const executableCapabilities = [...WORKSHOP_EXECUTABLE_CAPABILITIES]
    .sort((a, b) => `${a.kind}/${a.logicalId}`.localeCompare(`${b.kind}/${b.logicalId}`));
  const manifestDigest = sha256Hex({
    workshopId: WORKSHOP_ID,
    epoch: WORKSHOP_EPOCH,
    payloadContracts,
    executableCapabilities,
  });
  return {
    workshopId: WORKSHOP_ID,
    epoch: WORKSHOP_EPOCH,
    payloadContracts,
    payloadContractCount: payloadContracts.length,
    executableCapabilities,
    executableCapabilityCount: executableCapabilities.length,
    manifestDigest,
  };
}

function requireExecutableCapability(
  kind: ExecutableCapabilityManifestEntry['kind'],
  logicalId: string,
  version: string,
  implementationDigest: string,
): void {
  const binding = WORKSHOP_EXECUTABLE_CAPABILITIES.find(entry =>
    entry.kind === kind && entry.logicalId === logicalId);
  if (!binding) throw new Error(`WORKSHOP_CAPABILITY_UNDECLARED: ${kind}/${logicalId}`);
  if (
    binding.version !== version
    || binding.implementationDigest !== implementationDigest
  ) {
    throw new Error(`WORKSHOP_CAPABILITY_BINDING_MISMATCH: ${kind}/${logicalId}`);
  }
}

export function registerWorkshopCheckProvider(provider: CheckProvider): void {
  requireExecutableCapability(
    'check-provider', provider.providerId, provider.version, provider.providerDigest,
  );
  registerFactoryCheckProvider(provider);
}

export function registerWorkshopPostAcceptanceEffect(effectBinding: PostAcceptanceEffect): void {
  requireExecutableCapability(
    'post-acceptance-effect', effectBinding.effectId,
    effectBinding.version, effectBinding.effectDigest,
  );
  registerFactoryPostAcceptanceEffect(effectBinding);
}

export function assertWorkshopTransitionHandlerBinding(input: {
  readonly handoffKind: string;
  readonly ownerCapability: string;
}): void {
  requireExecutableCapability(
    'transition-handler', input.handoffKind, '1.0.0',
    sha256Hex({
      logicalId: input.handoffKind,
      owner: input.ownerCapability,
      protocol: 'factory-transition-obligation.v1',
    }),
  );
  const manifestEntry = WORKSHOP_EXECUTABLE_CAPABILITIES.find(entry =>
    entry.kind === 'transition-handler' && entry.logicalId === input.handoffKind)!;
  resolvedTransitionHandlers.set(input.handoffKind, {
    kind: 'transition-handler',
    logicalId: manifestEntry.logicalId,
    version: manifestEntry.version,
    implementationDigest: manifestEntry.implementationDigest,
  });
}

function expectedBindings(role: WorkshopProcessRole): WorkshopResolvedBinding[] {
  const payloads = buildWorkshopCapabilityManifest().payloadContracts.map(entry => ({
    kind: 'payload-contract' as const,
    logicalId: entry.schemaId,
    version: `${entry.contractId}@${entry.version}`,
    implementationDigest: entry.contractDigest,
  }));
  const executable = WORKSHOP_EXECUTABLE_CAPABILITIES
    .filter(entry => entry.roles.includes(role))
    .map(entry => ({
      kind: entry.kind,
      logicalId: entry.logicalId,
      version: entry.version,
      implementationDigest: entry.implementationDigest,
    }));
  return [...payloads, ...executable]
    .sort((a, b) => `${a.kind}/${a.logicalId}`.localeCompare(`${b.kind}/${b.logicalId}`));
}

function resolvedBindings(role: WorkshopProcessRole): WorkshopResolvedBinding[] {
  const payloads = snapshotProductPayloadContracts().map(entry => ({
    kind: 'payload-contract' as const,
    logicalId: entry.schemaId,
    version: `${entry.contractId}@${entry.version}`,
    implementationDigest: entry.contractDigest,
  }));
  if (role !== 'orchestrator') {
    return payloads.sort((a, b) => `${a.kind}/${a.logicalId}`.localeCompare(`${b.kind}/${b.logicalId}`));
  }
  const checks = createStandardCheckProviderRegistry().snapshot().map(entry => ({
    kind: 'check-provider' as const,
    logicalId: entry.providerId,
    version: entry.version,
    implementationDigest: entry.providerDigest,
  }));
  const effects = createPostAcceptanceEffectRegistry().snapshot().map(entry => ({
    kind: 'post-acceptance-effect' as const,
    logicalId: entry.effectId,
    version: entry.version,
    implementationDigest: entry.effectDigest,
  }));
  return [...payloads, ...checks, ...effects, ...resolvedTransitionHandlers.values()]
    .sort((a, b) => `${a.kind}/${a.logicalId}`.localeCompare(`${b.kind}/${b.logicalId}`));
}

export function recordWorkshopBindingReceipt(input: {
  readonly db: SqlDatabasePort;
  readonly role: WorkshopProcessRole;
  readonly processIdentity: string;
}): { readonly receiptRef: string; readonly bindingDigest: string } {
  const manifest = buildWorkshopCapabilityManifest();
  const expected = expectedBindings(input.role);
  const resolved = resolvedBindings(input.role);
  if (canonicalJson(expected) !== canonicalJson(resolved)) {
    throw new Error(
      `WORKSHOP_PROCESS_BINDING_MISMATCH: role=${input.role}; expected=${canonicalJson(expected)}; `
      + `resolved=${canonicalJson(resolved)}`,
    );
  }
  const bindingDigest = sha256Hex({
    manifestDigest: manifest.manifestDigest,
    role: input.role,
    bindings: resolved,
  });
  const receiptRef = `workshop-binding:${sha256Hex({
    bindingDigest,
    processIdentity: input.processIdentity,
  })}`;
  input.db.prepare(
    `INSERT OR IGNORE INTO factory_workshop_binding_receipts
      (receipt_ref,workshop_id,epoch,process_role,process_identity,
       manifest_digest,declared_snapshot,resolved_snapshot,binding_digest)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    receiptRef,
    manifest.workshopId,
    manifest.epoch,
    input.role,
    input.processIdentity,
    manifest.manifestDigest,
    canonicalJson(expected),
    canonicalJson(resolved),
    bindingDigest,
  );
  const row = input.db.prepare(
    `SELECT binding_digest FROM factory_workshop_binding_receipts WHERE receipt_ref=?`,
  ).get(receiptRef) as { binding_digest: string } | undefined;
  if (!row || row.binding_digest !== bindingDigest) {
    throw new Error(`WORKSHOP_BINDING_RECEIPT_REPLAY_MISMATCH: ${receiptRef}`);
  }
  return { receiptRef, bindingDigest };
}

/**
 * The manifest digest for the current build. Both processes compute this from
 * the same compiled `WORKSHOP_PAYLOAD_CONTRACTS`, so equality proves the two
 * processes carry the same payload-contract capability set.
 */
export function getWorkshopManifestDigest(): string {
  return buildWorkshopCapabilityManifest().manifestDigest;
}

/**
 * Install every workshop payload contract into the process-global registry.
 *
 * This is the SINGLE registration path for payload contracts. Both the
 * orchestrator (src/app/product-lifecycle-runtime.ts) and the worker MCP
 * (src/index.ts) call it. Module `register*` functions no longer call
 * `registerProductPayloadContract` directly — the architecture ratchet
 * (tests/architecture/workshop-manifest-parity.test.mjs) forbids it.
 *
 * Idempotent: the underlying registry deduplicates by exact contract identity.
 */
export function installWorkshopPayloadContracts(): WorkshopCapabilityManifest {
  const manifest = buildWorkshopCapabilityManifest();
  for (const contract of WORKSHOP_PAYLOAD_CONTRACTS) {
    registerProductPayloadContract(contract);
  }
  return manifest;
}
