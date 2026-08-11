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

import { sha256Hex } from '../../shared/canonical-json.js';
import type { ProductPayloadContract } from './product-payload-contract.js';
import {
  developmentReviewVerdictPayloadContract,
  developmentTaskGraphPayloadContract,
  developmentVerificationPayloadContract,
} from '../../modules/development/application/development-check-providers.js';
import { factoryReviewVerdictPayloadContract } from './review-verdict-check-provider.js';
import { registerProductPayloadContract } from './product-payload-contract.js';

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
  readonly manifestDigest: string;
}

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
  const manifestDigest = sha256Hex({
    workshopId: WORKSHOP_ID,
    epoch: WORKSHOP_EPOCH,
    payloadContracts,
  });
  return {
    workshopId: WORKSHOP_ID,
    epoch: WORKSHOP_EPOCH,
    payloadContracts,
    payloadContractCount: payloadContracts.length,
    manifestDigest,
  };
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
