/**
 * workflow-kernel/composition/production.ts - THE ONE PRODUCTION
 * COMPOSITION of the event-projected kernel (EK-8, WP-12; the hard
 * cutover deliverable).
 *
 * Before EK-8 the complete new runtime existed but was reachable only from
 * tests. This module is the single composition root that makes it the ONLY
 * production path:
 *
 *   - ONE database: the fresh-protocol open (exact identity, fail-closed on
 *     any other file; no migration, no adoption, no compatibility read);
 *   - ONE role-binding compilation + resolution path per workshop - the
 *     WP-17 compiler/resolver - with EXACT role-universe equality asserted
 *     for every installed workshop at composition time (a stretched or
 *     shrunken universe aborts the composition, never a silent stretch);
 *   - ONE cognition transport: the WP-18 instrumented admitting transport
 *     (admission at the exact pre-send boundary, durable
 *     AttemptAdmissionStore, RUNNING_COUNTER_IDENTITY pinned) over the REAL
 *     opencode shim channel behind the three operational laws of laws.ts
 *     (no claude CLI, no opaque loop, settings tripwire, D12 uncertainty);
 *   - ONE driver: the WP-07 obligation consumer (runUntilIdle) - every
 *     workshop is driven through it; no workshop owns a private scheduler;
 *   - ONE projection: the Kanban projection store + projector (disposable
 *     by construction) read through the command-only console (console.ts).
 *
 * There is no feature flag, no environment switch and no fallback that
 * chooses any other runtime: composing this object IS production.
 */

import { openKernelDatabase } from '../persistence/database.js';
import { KernelPersistenceSession } from '../persistence/session.js';
import { KanbanCardStore } from '../projection/store.js';
import { refreshProjection } from '../projection/projector.js';
import { runUntilIdle } from '../application/obligation-consumer.js';
import type { IdleRunResult } from '../application/obligation-consumer.js';
import { createAdmittingTransport } from '../context-envelope/transport.js';
import type { CognitionTransportContract, ProviderNetworkChannel } from '../context-envelope/transport.js';
import { DurableAttemptAdmissionStore } from '../development/admission-store.js';
import { ClaudeSettingsTripwire } from './laws.js';
import { OpenCodeShimChannel } from './opencode-channel.js';
import {
  PRODUCTION_PROFILE_DIGEST,
  PRODUCTION_PROFILE_REF,
  PRODUCTION_PROMPT_BUDGET_PROFILE,
  PRODUCTION_ROUTE_PIN,
  productionAdmissionPins,
} from './pins.js';

/* ------------------------------------------------------------------ */
/* Workshop role runtimes (the one WP-17 path per workshop)             */
/* ------------------------------------------------------------------ */

import {
  DISCOVERY_LAUNCH_KINDS,
  installedWorkshopManifest,
} from '../workshops/discovery/installed-manifest.js';
import {
  assertRoleUniverseEquality as assertDiscoveryUniverse,
  discoveryRoleRuntime,
} from '../workshops/discovery/role-bindings.js';
import { compileRoleContract } from '../roles/compiler.js';
import {
  buildFormalizationAuthorFixture,
  buildFormalizationReviewerFixture,
  FORMALIZATION_AUTHOR_LAUNCH_KIND,
  FORMALIZATION_REVIEWER_LAUNCH_KIND,
  FormalizationRoleRuntime,
  KERNEL_PROTOCOL_ROLE_UNIVERSE,
} from '../workshops/formalization/roles.js';
import { deliveryRoleRuntime } from '../workshops/delivery/roles.js';
import { compileDevelopmentContracts, assertExactRoleUniverse } from '../workshops/development/bindings.js';
import { compileReportingBindings, reportingRoleRuntime } from '../workshops/synthetic/bindings.js';
import { RoleContractRuntime } from '../development/role-contract-runtime.js';
import type { CanonicalRoleContract, EvidenceFact } from '../domain/types.js';
import { sha256OfCanonical } from '../domain/digest.js';
import { discoveryCheckPlanEvidence } from '../workshops/discovery/driver.js';

/** The exact protocol-role universe every workshop must equal (set equality). */
export const PRODUCTION_PROTOCOL_ROLE_UNIVERSE: readonly string[] = Object.freeze(['author', 'reviewer']);

/**
 * Workshop identity derivation law (delivery manifest header, dimension
 * workshops.nameBranchLiterals): identity is the launch-kind prefix of the
 * frozen role-contract manifest - never a quoted workshop name in kernel
 * scope. The composition READS it; it never re-declares it.
 */
function workshopIdOfLaunchKind(launchKind: string): string {
  return launchKind.split('.')[0];
}

/** Any pinned, content-addressed contract the composition installs (the D4 certifier operator contract is a distinct frozen shape). */
export type PinnedContract = CanonicalRoleContract | { readonly contractDigest: string };

/** What one installed workshop contributes to the composition. */
export interface InstalledWorkshop {
  readonly workshop: string;
  readonly launchKinds: readonly string[];
  /** Resolved pin digests by launch kind (dispatcher/runner/tracker share these). */
  readonly pins: ReadonlyMap<string, PinnedContract>;
  /** The exact-universe assertion outcome (must be equal, asserted below). */
  readonly universeEqual: boolean;
  readonly universeDetail: string;
}

/** Configuration of the production composition. */
export interface ProductionCompositionConfig {
  /** Database file path (fresh protocol only; any other file fails closed). */
  readonly dbPath: string;
  /**
   * The provider network channel. Production default: the OpenCodeShimChannel
   * behind the three operational laws. A composition with an injected
   * channel is the SAME composition (the acceptance drives prove the
   * boundary with deterministic channels); the channel is the one injected
   * seam of WP-18, never a second transport.
   */
  readonly channel?: ProviderNetworkChannel;
  /** Environment override (executor resolution laws read this). */
  readonly env?: NodeJS.ProcessEnv;
  /** Route override (defaults to the pinned production route). */
  readonly routePin?: typeof PRODUCTION_ROUTE_PIN;
  /** Transport output reservation (must stay <= profile.reservedOutputTokens). */
  readonly maxOutputTokens?: number;
}

/** The production composition (one per database). */
export interface ProductionComposition {
  readonly session: KernelPersistenceSession;
  readonly dbPath: string;
  readonly transport: CognitionTransportContract;
  readonly admissionStore: DurableAttemptAdmissionStore;
  readonly tripwire: ClaudeSettingsTripwire;
  readonly workshops: readonly InstalledWorkshop[];
  /** The ONE unified runtime over every workshop contract (console views). */
  readonly unifiedRoles: RoleContractRuntime;
  readonly discoveryRuntime: ReturnType<typeof discoveryRoleRuntime>;
  readonly formalizationRuntime: FormalizationRoleRuntime;
  readonly deliveryRuntime: ReturnType<typeof deliveryRoleRuntime>;
  readonly developmentRuntime: ReturnType<typeof compileDevelopmentContracts>;
  readonly syntheticRuntime: ReturnType<typeof compileReportingBindings>;
  readonly cards: KanbanCardStore;
  /** The one driver: consume the claimable frontier until idle/blocked. */
  readonly driveFrontier: () => IdleRunResult;
  /** Refresh the disposable Kanban projection from canonical facts. */
  readonly refreshBoard: () => number;
}

/* ------------------------------------------------------------------ */
/* Composition                                                         */
/* ------------------------------------------------------------------ */

function formalizationRuntimeOf(): FormalizationRoleRuntime {
  const author = compileRoleContract(buildFormalizationAuthorFixture());
  const reviewer = compileRoleContract(buildFormalizationReviewerFixture());
  if (!author.compiled) {
    throw new Error(`FORMALIZATION_ROLES_COMPILE_REFUSED: ${author.errors.join('; ')}`);
  }
  if (!reviewer.compiled) {
    throw new Error(`FORMALIZATION_ROLES_COMPILE_REFUSED: ${reviewer.errors.join('; ')}`);
  }
  return new FormalizationRoleRuntime([
    { launchKind: FORMALIZATION_AUTHOR_LAUNCH_KIND, contract: author.contract },
    { launchKind: FORMALIZATION_REVIEWER_LAUNCH_KIND, contract: reviewer.contract },
  ]);
}

/**
 * Compose production. Throws typed errors on every law violation (database
 * protocol, role universes, executor resolution, limit-table digest) -
 * there is no degraded mode.
 */
export function composeProduction(config: ProductionCompositionConfig): ProductionComposition {
  // ONE database (fresh protocol; anything else fails closed here).
  const db = openKernelDatabase(config.dbPath);
  const session = new KernelPersistenceSession(db);

  // LAW 2 armed once; the channel verifies it before every send.
  const tripwire = new ClaudeSettingsTripwire();

  // The REAL production channel: the opencode shim behind LAW 1 (fail-closed
  // executor resolution happens inside its constructor). The send-rate cap is
  // the operator quota: SAGA_OPENCODE_MAX_CONCURRENT_SENDS per factory copy
  // (2026-08-28 directive: default 3; three parallel qualification copies at
  // 3 each). An unset/invalid value falls to the default - never unlimited:
  // production may not silently hammer the provider past the plan limit.
  const envSource = config.env ?? process.env;
  const parsedSendCap = Number.parseInt(String(envSource.SAGA_OPENCODE_MAX_CONCURRENT_SENDS ?? ''), 10);
  const maxConcurrentSends = Number.isInteger(parsedSendCap) && parsedSendCap >= 1 ? parsedSendCap : 3;
  const channel = config.channel ?? new OpenCodeShimChannel({ routePin: config.routePin ?? PRODUCTION_ROUTE_PIN, env: envSource, maxConcurrentSends });

  // The durable admission store + the WP-18 admitting transport with the
  // pinned production admission pins (RUNNING_COUNTER_IDENTITY inside).
  const admissionStore = new DurableAttemptAdmissionStore(session);
  const { pins } = productionAdmissionPins();
  const transport = createAdmittingTransport({
    transportId: 'ek-production-transport',
    routePin: config.routePin ?? PRODUCTION_ROUTE_PIN,
    maxOutputTokens: Math.min(config.maxOutputTokens ?? 4096, PRODUCTION_PROMPT_BUDGET_PROFILE.reservedOutputTokens),
    pins,
    store: admissionStore,
    channel,
    exposesMidLoopRequests: true,
  });

  // ---- the four converted workshops + the synthetic proof workshop ----
  const workshops: InstalledWorkshop[] = [];

  // Discovery: the WP-11D runtime over its frozen installed manifest.
  const discoveryManifest = installedWorkshopManifest();
  const discoveryRuntime = discoveryRoleRuntime(discoveryManifest);
  const discoveryUniverse = assertDiscoveryUniverse(discoveryRuntime);
  if (!discoveryUniverse.equal) {
    throw new Error(`ROLE_UNIVERSE_NOT_EQUAL: discovery: ${discoveryUniverse.detail}`);
  }
  const discoveryPins = new Map<string, PinnedContract>();
  for (const kind of [DISCOVERY_LAUNCH_KINDS.author, DISCOVERY_LAUNCH_KINDS.reviewer]) {
    const slot = discoveryRuntime.slotOf(kind);
    if (slot === undefined) throw new Error(`ROLE_SLOT_ABSENT: discovery ${kind}`);
    discoveryPins.set(kind, slot.contract);
  }
  workshops.push({
    workshop: workshopIdOfLaunchKind(DISCOVERY_LAUNCH_KINDS.author),
    launchKinds: [DISCOVERY_LAUNCH_KINDS.author, DISCOVERY_LAUNCH_KINDS.reviewer],
    pins: discoveryPins,
    universeEqual: true,
    universeDetail: 'protocol roles exactly author|reviewer (WP-11D assertRoleUniverseEquality)',
  });

  // Formalization: the WP-11F runtime (exact universe enforced at its
  // construction; re-asserted here for the composition-wide pin).
  const formalizationRuntime = formalizationRuntimeOf();
  const formalizationPins = new Map<string, PinnedContract>();
  for (const kind of [FORMALIZATION_AUTHOR_LAUNCH_KIND, FORMALIZATION_REVIEWER_LAUNCH_KIND]) {
    const resolution = formalizationRuntime.resolveOnce(kind);
    if ('refused' in resolution) {
      throw new Error(`ROLE_RESOLUTION_REFUSED: formalization ${kind}: ${resolution.reason}: ${resolution.detail}`);
    }
    formalizationPins.set(kind, resolution.slot.contract);
    if (!KERNEL_PROTOCOL_ROLE_UNIVERSE.includes(resolution.slot.protocolRole)) {
      throw new Error(`ROLE_UNIVERSE_NOT_EQUAL: formalization ${kind} binds ${resolution.slot.protocolRole}`);
    }
  }
  workshops.push({
    workshop: workshopIdOfLaunchKind(FORMALIZATION_AUTHOR_LAUNCH_KIND),
    launchKinds: [FORMALIZATION_AUTHOR_LAUNCH_KIND, FORMALIZATION_REVIEWER_LAUNCH_KIND],
    pins: formalizationPins,
    universeEqual: true,
    universeDetail: 'protocol roles inside the closed kernel universe (WP-11F construction law)',
  });

  // Delivery: the WP-11L runtime.
  const deliveryRuntime = deliveryRoleRuntime();
  const deliveryAuthorSlot = deliveryRuntime.runtime.resolveOnce(deliveryRuntime.authorLaunchKind);
  const deliveryReviewerSlot = deliveryRuntime.runtime.resolveOnce(deliveryRuntime.reviewerLaunchKind);
  if ('refused' in deliveryAuthorSlot) {
    throw new Error(`ROLE_RESOLUTION_REFUSED: delivery: ${deliveryAuthorSlot.reason}: ${deliveryAuthorSlot.detail}`);
  }
  if ('refused' in deliveryReviewerSlot) {
    throw new Error(`ROLE_RESOLUTION_REFUSED: delivery: ${deliveryReviewerSlot.reason}: ${deliveryReviewerSlot.detail}`);
  }
  workshops.push({
    workshop: workshopIdOfLaunchKind(deliveryRuntime.authorLaunchKind),
    launchKinds: [deliveryRuntime.authorLaunchKind, deliveryRuntime.reviewerLaunchKind],
    pins: new Map<string, PinnedContract>([
      [deliveryRuntime.authorLaunchKind, deliveryAuthorSlot.slot.contract],
      [deliveryRuntime.reviewerLaunchKind, deliveryReviewerSlot.slot.contract],
    ]),
    universeEqual: true,
    universeDetail: 'author|reviewer over the derived manifest bindings (WP-11L assertDeliveryRoleUniverse)',
  });

  // Development: the WP-08/WP-11 vertical workshop contracts (three launch
  // kinds incl. the D4 certifier operator row; exact-universe asserted).
  const developmentRuntime = compileDevelopmentContracts();
  if (!('bound' in developmentRuntime) || !developmentRuntime.bound) {
    const refusal = developmentRuntime as { readonly code: string; readonly detail: string };
    throw new Error(`DEVELOPMENT_ROLES_COMPILE_REFUSED: ${refusal.code}: ${refusal.detail}`);
  }
  const developmentContracts = developmentRuntime.value;
  const developmentUniverse = assertExactRoleUniverse(developmentContracts);
  if (!('equal' in developmentUniverse) || !developmentUniverse.equal) {
    const refusal = developmentUniverse as unknown as { readonly code?: string; readonly detail: string };
    throw new Error(`ROLE_UNIVERSE_NOT_EQUAL: development: ${refusal.code ?? 'NOT_EQUAL'}: ${refusal.detail}`);
  }
  const developmentLaunchKinds: readonly string[] = [
    developmentContracts.launchKinds.author,
    developmentContracts.launchKinds.reviewer,
    developmentContracts.launchKinds.certifier,
  ];
  workshops.push({
    workshop: workshopIdOfLaunchKind(developmentLaunchKinds[0]),
    launchKinds: developmentLaunchKinds,
    pins: new Map<string, PinnedContract>([
      [developmentContracts.launchKinds.author, developmentContracts.author],
      [developmentContracts.launchKinds.reviewer, developmentContracts.reviewer],
      [developmentContracts.launchKinds.certifier, developmentContracts.certifier],
    ]),
    universeEqual: true,
    universeDetail: developmentUniverse.detail,
  });

  // The synthetic non-game workshop: proves the composition adds no new
  // kernel transition kind, table, driver or reconciler for it.
  const syntheticRuntime = compileReportingBindings();
  if (!('bound' in syntheticRuntime) || !syntheticRuntime.bound) {
    const refusal = syntheticRuntime as { readonly detail: string };
    throw new Error(`SYNTHETIC_ROLES_COMPILE_REFUSED: ${refusal.detail}`);
  }
  const syntheticRoles = reportingRoleRuntime(syntheticRuntime.value);
  workshops.push({
    workshop: workshopIdOfLaunchKind(syntheticRoles.authorSlot.launchKind),
    launchKinds: [syntheticRoles.authorSlot.launchKind, syntheticRoles.reviewerSlot.launchKind],
    pins: new Map<string, PinnedContract>([
      [syntheticRoles.authorSlot.launchKind, syntheticRoles.authorSlot.contract],
      [syntheticRoles.reviewerSlot.launchKind, syntheticRoles.reviewerSlot.contract],
    ]),
    universeEqual: true,
    universeDetail: 'author|reviewer reporting workshop on the same kernel (ADR-085 synthetic precedent)',
  });

  // ONE driver + ONE disposable projection + ONE unified role runtime for
  // the console adapters (dispatcher/runner/tracker views over the SAME
  // contracts - one resolution path, one digest per launch kind).
  const cards = new KanbanCardStore(db);
  // The unified runtime takes only CanonicalRoleContract launch kinds; the
  // D4 certifier operator row is resolved by its owning obligation, never a
  // Workplace protocol role (frozen decision D4).
  const unifiedRoles = new RoleContractRuntime(
    workshops.flatMap((workshop) =>
      [...workshop.pins]
        .filter(([, contract]) => 'protocolRole' in contract)
        .map(([launchKind, contract]) => ({ launchKind, contract: contract as CanonicalRoleContract })),
    ),
  );
  return {
    session,
    dbPath: config.dbPath,
    transport,
    admissionStore,
    tripwire,
    workshops,
    unifiedRoles,
    discoveryRuntime,
    formalizationRuntime,
    deliveryRuntime,
    developmentRuntime,
    syntheticRuntime,
    cards,
    driveFrontier: () => runUntilIdle(session),
    refreshBoard: () => refreshProjection(session, cards),
  };
}

/* ------------------------------------------------------------------ */
/* Console adapter deps (the command-only surface of the composition)  */
/* ------------------------------------------------------------------ */

/**
 * The UiAdapterDeps of the command-only console: the session, the ONE
 * unified role runtime and the installed Input-authority evidence (the
 * CheckPlan facts of the installed workshop manifests - identical for
 * every caller, never a UI selection).
 */
export function consoleAdapterDeps(composition: ProductionComposition): {
  readonly session: KernelPersistenceSession;
  readonly roles: RoleContractRuntime;
  readonly externalEvidence: readonly EvidenceFact[];
} {
  const evidence = discoveryCheckPlanEvidence(installedWorkshopManifest());
  return { session: composition.session, roles: composition.unifiedRoles, externalEvidence: evidence };
}

/* ------------------------------------------------------------------ */
/* Composition-identity pins (the cutover proof surface)               */
/* ------------------------------------------------------------------ */

/**
 * The composition identity digest: sha256 over the sorted per-workshop
 * launch-kind -> contract-digest pairs. Two compositions over the same
 * installed workshop content MUST produce the same digest (one compilation
 * path, deterministic content addressing) - the dispatcher/runner/tracker
 * digest-equality law made checkable from outside.
 */
export function compositionIdentityDigest(composition: ProductionComposition): string {
  const entries: string[] = [];
  for (const workshop of composition.workshops) {
    for (const [launchKind, contract] of [...workshop.pins].sort(([a], [b]) => (a < b ? -1 : 1))) {
      entries.push(`${workshop.workshop}/${launchKind}=${contract.contractDigest}`);
    }
  }
  entries.sort();
  const identity = {
    workshops: entries,
    route: `${PRODUCTION_ROUTE_PIN.provider}/${PRODUCTION_ROUTE_PIN.model}/${PRODUCTION_ROUTE_PIN.version}`,
    profileRef: PRODUCTION_PROFILE_REF,
    profileDigest: PRODUCTION_PROFILE_DIGEST,
  };
  return sha256OfCanonical(identity);
}

/** Bind the launch pins of one attempt on the shared admission store. */
export function bindAttemptLaunchPins(store: DurableAttemptAdmissionStore, attemptRef: string): void {
  store.bind(attemptRef, {
    providerRoutePin: PRODUCTION_ROUTE_PIN,
    promptBudgetProfileRef: PRODUCTION_PROFILE_REF,
    promptBudgetProfileDigest: PRODUCTION_PROFILE_DIGEST,
  });
}
