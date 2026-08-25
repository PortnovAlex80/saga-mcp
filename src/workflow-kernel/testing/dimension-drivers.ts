/**
 * workflow-kernel/testing/dimension-drivers.ts - the EK-9 required-dimension
 * driver scenarios (WP-13B): context budget, role binding and concurrency.
 *
 * Every driver is a DATA record with an INDEPENDENTLY authored expectation
 * (from the frozen laws: the WP-18 accountant formulas, the WP-17 resolver
 * law, the durable-handoff/CAS fences) plus a deterministic executor over
 * the public surfaces:
 *
 *   - context budget: WP-18 admitProviderRequest + the admitting transport
 *     (the exact pre-send boundary; scripted channel, no network);
 *   - role binding: WP-17 installRoleContracts/resolveRoleContract (the ONE
 *     resolution path) + the kernel admitWorkIntent/activityAttempt guards;
 *   - concurrency: deterministic interleavings of independent command
 *     streams over the pure reference machine (cap, barrier, stale lease,
 *     two consumers) and the WP-18 CAS admission race.
 *
 * PURITY: node builtins + kernel packages. No clock, no network, no model.
 */

import type { CanonicalRoleContractReference, CommandInput, EvidenceFact, TypedRefusal } from '../domain/types.js';
import { applyCommand, createWorld, type KernelWorld } from '../domain/explorer.js';
import {
  RUNNING_COUNTER_IDENTITY,
  countTokens,
  tableRowsDigestOf,
  type PromptBudgetProfile,
  type ProviderModelLimitTableArtifact,
} from '../context-envelope/accountant.js';
import type { ProviderRoutePin, ContextEnvelope, EnvelopeLayer } from '../context-envelope/receipt.js';
import {
  InMemoryAttemptAdmissionStore,
  initialAttemptCounters,
  type AdmissionOutcome,
} from '../context-envelope/admission.js';
import { createAdmittingTransport } from '../context-envelope/transport.js';
import type { TransportSendResult, PreSendRefusalKind } from '../context-envelope/transport.js';
import { mandatoryLayers, tokenText } from './fixtures.js';

/* ================================================================== */
/* CONTEXT BUDGET dimension (12 required drivers)                       */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* A self-contained valid pin set (limit table + profile)               */
/* ------------------------------------------------------------------ */

/** The read-only exact-key limit table artifact of the driver corpus. */
export function budgetLimitTable(): ProviderModelLimitTableArtifact {
  return {
    kind: 'provider-model-limit-table',
    rows: [
      { provider: 'zai', model: 'glm-5.2', version: 'catalog-ek-wp13b', contextLimitTokens: 131072 },
      { provider: 'zai', model: 'glm-5.2-mini', version: 'catalog-ek-wp13b', contextLimitTokens: 32768 },
    ],
  };
}

/** The driver route pin (full-capacity row; the mini row is the reduced one). */
export const DRIVER_ROUTE_PIN: ProviderRoutePin = { provider: 'zai', model: 'glm-5.2', version: 'catalog-ek-wp13b' };

/** The reduced-provider-limit route (the same provider, smaller window). */
export const REDUCED_ROUTE_PIN: ProviderRoutePin = { provider: 'zai', model: 'glm-5.2-mini', version: 'catalog-ek-wp13b' };

/** A valid PromptBudgetProfile for the drivers (positive finite, coherent). */
export function budgetProfile(overrides: Partial<PromptBudgetProfile> = {}): PromptBudgetProfile {
  const table = budgetLimitTable();
  return {
    providerModelLimitTableRef: { ref: 'content://provider-model-limit-tables/ek-wp13b', digest: tableRowsDigestOf(table.rows), digestAlgorithm: 'sha256' },
    providerContextLimitTokens: 131072,
    tokenCounterRef: { ...RUNNING_COUNTER_IDENTITY },
    maxProviderRequests: 40,
    maxStaticTokens: 2500,
    maxDynamicTokens: 1600,
    maxRecoveryTokens: 500,
    maxToolResultTokens: 400,
    maxTotalInputTokens: 5000,
    maxCumulativeSessionInputTokens: 5000,
    reservedOutputTokens: 8192,
    providerOverheadReserveTokens: 2048,
    safetyMarginTokens: 4096,
    maxPromptBytes: 393216,
    ...overrides,
  };
}

/** The reduced-provider-limit profile (a coherent smaller window, mini row). */
export function reducedLimitProfile(): PromptBudgetProfile {
  return budgetProfile({
    providerContextLimitTokens: 32768,
    maxTotalInputTokens: 18000,
    maxStaticTokens: 9000,
    maxDynamicTokens: 6000,
    maxRecoveryTokens: 2000,
    maxToolResultTokens: 2000,
    maxCumulativeSessionInputTokens: 180000,
  });
}

/** A conforming envelope with exact per-layer token control. */
export function driverEnvelope(options: {
  readonly staticEach?: number;
  readonly task?: number;
  readonly workspace?: number;
  readonly hook?: number;
  readonly recovery?: number;
  readonly toolResults?: number;
  readonly rawTask?: boolean;
  readonly rawWorkspace?: boolean;
  readonly duplicateHistory?: boolean;
  readonly largeReference?: boolean;
} = {}): ContextEnvelope {
  const { staticEach = 3, task = 10, workspace = 10, hook = 0, recovery = 0, toolResults = 0, rawTask = false, rawWorkspace = false, duplicateHistory = false, largeReference = false } = options;
  const layers: EnvelopeLayer[] = mandatoryLayers(staticEach) as EnvelopeLayer[];
  if (task > 0) layers.push({ layer: 'task-projection', content: tokenText(task), boundedTransportForm: !rawTask });
  if (workspace > 0) layers.push({ layer: 'workspace-summary', content: tokenText(workspace), boundedTransportForm: !rawWorkspace });
  if (recovery > 0) {
    layers.push({ layer: 'recovery-history', content: tokenText(recovery) });
    if (duplicateHistory) layers.push({ layer: 'recovery-history', content: tokenText(recovery) });
  }
  if (hook > 0) layers.push({ layer: 'hook-context', content: tokenText(hook) });
  if (toolResults > 0) layers.push({ layer: 'tool-results', content: tokenText(toolResults) });
  if (largeReference) {
    layers.push({
      layer: 'desk-reference',
      content: tokenText(2),
      externalReferences: [{ ref: 'content://desks/reviewer/ek-wp13b', digest: `sha256:${'b'.repeat(64)}`, summary: 'reviewer desk (bounded pointer)' }],
    });
  }
  return { layers };
}

/**
 * A token-exact envelope sized to `totalTokens` against a profile: fills
 * static/recovery/tool/workspace/task inside their class budgets (90% by
 * default) and absorbs the remainder in the reference class (the uncapped
 * bounded-pointer layer), so the PER-REQUEST cap is the binding limit.
 */
export function envelopeWithinProfile(
  profile: PromptBudgetProfile,
  totalTokens: number,
  options: { readonly duplicateHistory?: boolean; readonly rawTask?: boolean; readonly largeReference?: boolean } = {},
): ContextEnvelope {
  if (totalTokens < 10) throw new Error(`envelopeWithinProfile: total ${totalTokens} is below any well-formed envelope`);
  let staticEach: number;
  let staticTokens: number;
  let recoveryTokens = 0;
  let toolTokens = 0;
  let workspaceTokens: number;
  if (totalTokens < 50) {
    staticEach = 1;
    staticTokens = 5;
    workspaceTokens = 0;
  } else {
    staticTokens = Math.min(Math.floor((profile.maxStaticTokens * 0.9) / 5) * 5, Math.floor(totalTokens * 0.4));
    staticEach = Math.max(1, Math.floor(staticTokens / 5));
    staticTokens = staticEach * 5;
    recoveryTokens = Math.min(Math.floor(profile.maxRecoveryTokens * 0.9), Math.floor((totalTokens - staticTokens) * 0.15));
    toolTokens = Math.min(Math.floor(profile.maxToolResultTokens * 0.9), Math.floor((totalTokens - staticTokens - recoveryTokens) * 0.15));
    workspaceTokens = Math.min(100, Math.max(0, totalTokens - staticTokens - recoveryTokens - toolTokens - 1));
  }
  let remaining = totalTokens - staticTokens - recoveryTokens - toolTokens - workspaceTokens;
  if (remaining < 0) {
    throw new Error(`envelopeWithinProfile: total ${totalTokens} below the fixed class fill (${staticTokens + recoveryTokens + toolTokens + workspaceTokens})`);
  }
  const taskTokens = Math.min(remaining, profile.maxDynamicTokens - workspaceTokens);
  remaining -= taskTokens;

  const layers: EnvelopeLayer[] = mandatoryLayers(staticEach) as EnvelopeLayer[];
  if (taskTokens > 0) layers.push({ layer: 'task-projection', content: tokenText(taskTokens), boundedTransportForm: !options.rawTask });
  if (workspaceTokens > 0) layers.push({ layer: 'workspace-summary', content: tokenText(workspaceTokens), boundedTransportForm: true });
  if (recoveryTokens > 0) {
    layers.push({ layer: 'recovery-history', content: tokenText(recoveryTokens) });
    if (options.duplicateHistory) layers.push({ layer: 'recovery-history', content: tokenText(recoveryTokens) });
  }
  if (toolTokens > 0) layers.push({ layer: 'tool-results', content: tokenText(toolTokens) });
  if (remaining > 0) {
    layers.push({ layer: 'large-product-refs', content: tokenText(remaining) });
  }
  if (options.largeReference) {
    layers.push({
      layer: 'desk-reference',
      content: tokenText(2),
      externalReferences: [{ ref: 'content://desks/reviewer/ek-wp13b', digest: `sha256:${'b'.repeat(64)}`, summary: 'reviewer desk (bounded pointer)' }],
    });
  }
  const counted = layers.reduce((sum, layer) => sum + countTokens(layer.content), 0);
  const expected = totalTokens + (options.duplicateHistory ? recoveryTokens : 0) + (options.largeReference ? 2 : 0);
  if (counted !== expected) {
    throw new Error(`envelopeWithinProfile: counted ${counted} tokens, expected ${expected} (distributor defect)`);
  }
  return { layers };
}

/** The pinned counter identity with a DRIFTED digest (one hex flipped). */
export function driftedCounterPin(): PromptBudgetProfile['tokenCounterRef'] {
  const identity = { ...RUNNING_COUNTER_IDENTITY };
  const flipped = identity.digest.endsWith('0') ? identity.digest.slice(0, -1) + '1' : identity.digest.slice(0, -1) + '0';
  return { ...identity, digest: flipped };
}

/* ------------------------------------------------------------------ */
/* The twelve drivers (data)                                           */
/* ------------------------------------------------------------------ */

/** What a driver expects the public admission/transport path to answer. */
export interface BudgetDriverExpectation {
  readonly admission: 'admitted' | { readonly refusedWith: string };
  readonly transport?: 'delivered' | { readonly refusedWith: PreSendRefusalKind } | 'effect-uncertainty';
  readonly secondAdmission?: 'admitted' | { readonly refusedWith: string } | { readonly staleRevision: true };
}

export interface BudgetDriverScenario {
  readonly id: string;
  readonly requirement: string;
  readonly profile?: PromptBudgetProfile;
  readonly routePin?: ProviderRoutePin;
  readonly envelope: ContextEnvelope;
  readonly secondEnvelope?: ContextEnvelope;
  readonly transportMaxOutputTokens?: number;
  readonly exposesMidLoopRequests?: boolean;
  readonly channel?: 'delivered' | 'unknown' | 'error';
  readonly sendMutation?: 'truncate-to-fit';
  readonly expected: BudgetDriverExpectation;
}

/** Effective input limit under the frozen formula (the authored oracle). */
export function effectiveInputLimit(profile: PromptBudgetProfile): number {
  return profile.providerContextLimitTokens - profile.reservedOutputTokens - profile.providerOverheadReserveTokens - profile.safetyMarginTokens;
}

/** The input cap of a request under the profile (the frozen formula). */
export function requestInputCap(profile: PromptBudgetProfile): number {
  return Math.min(profile.maxTotalInputTokens, effectiveInputLimit(profile));
}

/**
 * The twelve context-budget drivers. Expectations are authored from the
 * frozen accountant check order and refusal vocabulary, never scraped from
 * output.
 */
export function contextBudgetDrivers(): BudgetDriverScenario[] {
  const profile = budgetProfile();
  const reduced = reducedLimitProfile();
  const cap = requestInputCap(profile); // 5000 (maxTotalInputTokens binds first)
  const reducedCap = requestInputCap(reduced); // 18000
  return [
    {
      id: 'one-token-below',
      requirement: 'a request one token below the per-request cap is admitted',
      envelope: envelopeWithinProfile(profile, cap - 1),
      expected: { admission: 'admitted', transport: 'delivered' },
    },
    {
      id: 'exact-limit',
      requirement: 'a request at exactly the per-request cap is admitted',
      envelope: envelopeWithinProfile(profile, cap),
      expected: { admission: 'admitted', transport: 'delivered' },
    },
    {
      id: 'one-token-above',
      requirement: 'a request one token above the per-request cap is refused before any send',
      envelope: envelopeWithinProfile(profile, cap + 1),
      expected: { admission: { refusedWith: 'MAX_TOTAL_INPUT_TOKENS_EXCEEDED' } },
    },
    {
      id: 'reduced-provider-limit',
      requirement: 'the reduced provider/model window shrinks the cap; a full-window request is refused',
      routePin: REDUCED_ROUTE_PIN,
      profile: reduced,
      envelope: envelopeWithinProfile(reduced, reducedCap + 1),
      expected: { admission: { refusedWith: 'MAX_TOTAL_INPUT_TOKENS_EXCEEDED' } },
    },
    {
      id: 'duplicate-history',
      requirement: 'repeated recovery history cannot even normalize: one layer, one slot',
      envelope: envelopeWithinProfile(profile, 1000, { duplicateHistory: true }),
      expected: { admission: { refusedWith: 'UNCLASSIFIED_LAYER' } },
    },
    {
      id: 'raw-product-metadata',
      requirement: 'an unbounded (raw) product metadata row is refused, never silently bounded',
      envelope: envelopeWithinProfile(profile, 1000, { rawTask: true }),
      expected: { admission: { refusedWith: 'FORBIDDEN_DUPLICATION' } },
    },
    {
      id: 'disabled-zero-cap',
      requirement: 'a zero cap fails closed at the profile itself (no unbounded representation)',
      profile: budgetProfile({ maxTotalInputTokens: 0 }),
      envelope: driverEnvelope({ task: 10 }),
      expected: { admission: { refusedWith: 'PROFILE_NOT_POSITIVE_FINITE' } },
    },
    {
      id: 'silent-truncation-attempt',
      requirement: 'bytes truncated between admission and send break the receipt digest equality and the send is refused',
      envelope: envelopeWithinProfile(profile, 500),
      sendMutation: 'truncate-to-fit',
      expected: { admission: 'admitted', transport: { refusedWith: 'ENVELOPE_DIGEST_MISMATCH' } },
    },
    {
      id: 'large-reference',
      requirement: 'a large external reference enters as a bounded pointer and is admitted with the reference recorded',
      envelope: envelopeWithinProfile(profile, 1000, { largeReference: true }),
      expected: { admission: 'admitted', transport: 'delivered' },
    },
    {
      id: 'token-counter-drift',
      requirement: 'a drifted counter pin is a typed mismatch, never a silent recount',
      profile: budgetProfile({ tokenCounterRef: driftedCounterPin() }),
      envelope: driverEnvelope({ task: 10 }),
      expected: { admission: { refusedWith: 'TOKEN_COUNTER_MISMATCH' } },
    },
    {
      id: 'concurrent-admission',
      requirement: 'two admissions at the same context revision: one CAS win, one stale typed refusal',
      envelope: envelopeWithinProfile(profile, 400),
      secondEnvelope: envelopeWithinProfile(profile, 401),
      expected: { admission: 'admitted', secondAdmission: { staleRevision: true } },
    },
    {
      id: 'output-limit-mismatch',
      requirement: 'a transport output bound above the reserved output is refused before any send',
      envelope: envelopeWithinProfile(profile, 300),
      transportMaxOutputTokens: 8193,
      expected: { admission: 'admitted', transport: { refusedWith: 'OUTPUT_RESERVATION_EXCEEDED' } },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The budget driver executor                                          */
/* ------------------------------------------------------------------ */

export interface BudgetDriverRun {
  readonly driver: string;
  readonly admission: AdmissionOutcome;
  readonly secondAdmission?: AdmissionOutcome;
  readonly send?: TransportSendResult;
  readonly sentSerialized?: string;
  readonly counterIdentityDrift: boolean;
}

/** One scripted provider channel (deterministic; the injected port). */
export function scriptedChannel(script: 'delivered' | 'unknown' | 'error') {
  return {
    async send(input: { readonly serialized: string }): Promise<{ status: 'delivered'; outcomeDigest: string } | { status: 'unknown' }> {
      if (script === 'unknown') return { status: 'unknown' };
      if (script === 'error') throw new Error('EK_SCRIPTED_CHANNEL_ERROR');
      let hash = 2166136261;
      for (const byte of Buffer.from(input.serialized, 'utf8')) {
        hash ^= byte;
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return { status: 'delivered', outcomeDigest: `fnv1a:${hash.toString(16)}` };
    },
  };
}

/**
 * Execute one budget driver over the public admission command + the
 * admitting transport. Returns the raw outcomes; the TEST asserts the
 * authored expectation (declared must equal demonstrated).
 */
export async function runBudgetDriver(scenario: BudgetDriverScenario): Promise<BudgetDriverRun> {
  const profile = scenario.profile ?? budgetProfile();
  const pins = { profile, limitTable: budgetLimitTable() };
  const counters = initialAttemptCounters({
    attemptRef: `attempt:${scenario.id}`,
    providerRoutePin: scenario.routePin ?? DRIVER_ROUTE_PIN,
    promptBudgetProfileRef: 'content://prompt-budget-profiles/ek-wp13b',
    promptBudgetProfileDigest: `sha256:${'c'.repeat(64)}`,
  });
  const store = new InMemoryAttemptAdmissionStore([counters]);

  const transport = createAdmittingTransport({
    transportId: `transport:${scenario.id}`,
    routePin: scenario.routePin ?? DRIVER_ROUTE_PIN,
    maxOutputTokens: scenario.transportMaxOutputTokens ?? Math.min(8192, profile.reservedOutputTokens),
    pins,
    store,
    channel: scriptedChannel(scenario.channel ?? 'delivered'),
    exposesMidLoopRequests: scenario.exposesMidLoopRequests ?? true,
  });

  const admissionKey = `budget:${scenario.id}:1`;
  const admission = await transport.admitProviderRequest({
    attemptRef: counters.attemptRef,
    expectedContextRevision: 0,
    envelope: scenario.envelope,
    idempotencyKey: admissionKey,
  });

  let secondAdmission: AdmissionOutcome | undefined;
  if (scenario.secondEnvelope !== undefined) {
    secondAdmission = await transport.admitProviderRequest({
      attemptRef: counters.attemptRef,
      expectedContextRevision: 0, // same revision: the CAS race
      envelope: scenario.secondEnvelope,
      idempotencyKey: `budget:${scenario.id}:2`,
    });
  }

  let send: TransportSendResult | undefined;
  if (admission.kind === 'admitted') {
    // The send re-submits the SAME admission key (the committed-key replay
    // path). A silent-truncation attempt carries DIFFERENT bytes here; the
    // pre-send boundary must refuse them by digest equality.
    const envelope = scenario.sendMutation === 'truncate-to-fit' ? truncateEnvelopeLayers(scenario.envelope) : scenario.envelope;
    send = await transport.sendProviderRequest({
      attemptRef: counters.attemptRef,
      expectedContextRevision: admission.nextCounters.contextRevision,
      envelope,
      idempotencyKey: admissionKey,
    });
  }

  return {
    driver: scenario.id,
    admission,
    secondAdmission,
    send,
    counterIdentityDrift: profile.tokenCounterRef.digest !== RUNNING_COUNTER_IDENTITY.digest,
  };
}

/** Drop the last layer of an envelope (the silent truncation mutation). */
function truncateEnvelopeLayers(envelope: ContextEnvelope): ContextEnvelope {
  return { layers: envelope.layers.slice(0, -1) };
}

/** The request token count of an envelope under the pinned counter. */
export function envelopeTokenCount(envelope: ContextEnvelope): number {
  return envelope.layers.reduce((total, layer) => total + countTokens(typeof layer.content === 'string' ? layer.content : ''), 0);
}

/* ================================================================== */
/* ROLE BINDING dimension (5 required drivers)                          */
/* ================================================================== */

export type BindingDriverKind =
  | 'correct-digest'
  | 'foreign-digest'
  | 'stale-digest'
  | 'task-tag-mismatch'
  | 'downstream-reresolution';

export interface BindingDriverScenario {
  readonly id: BindingDriverKind;
  readonly requirement: string;
  /** The pin the WorkIntent carries. */
  readonly pin: CanonicalRoleContractReference;
  /** The closed installed set (install itself must succeed). */
  readonly installed: readonly unknown[];
  /** The launch kind the TASK row declares (route-policy lookup). */
  readonly taskLaunchKind: string;
  /** The downstream attempt input mutation (attempted re-resolution). */
  readonly downstreamMutation?: 'manifest-bag' | 'foreign-pin';
  readonly expected: {
    readonly resolution: 'resolved' | { readonly refusedWith: string };
    readonly routeRules: number | { readonly refusedWith: string };
    readonly kernel: 'committed' | { readonly refusedWith: string };
  };
}

/** Token-count helper re-export for driver tests. */
export { countTokens };

/* ================================================================== */
/* CONCURRENCY dimension (5 required drivers)                           */
/* ================================================================== */

export type ConcurrencyDriverKind = 'cap-1' | 'exact-cap-2' | 'cap-saturation-barrier' | 'stale-lease' | 'two-consumers';

export interface ConcurrencyDriverScenario {
  readonly id: ConcurrencyDriverKind;
  readonly requirement: string;
  readonly concurrencyCap: number;
  /** Independent command streams (each over its own aggregate instances). */
  readonly streams: readonly (readonly CommandInput[])[];
  /**
   * The deterministic barrier: phases of stream indexes that advance one
   * step each; a stream holds at the barrier until its phase arrives (the
   * observed in-flight peak is asserted against the cap).
   */
  readonly barrierPhases: readonly (readonly number[])[];
  readonly expected: {
    readonly peakInFlight: number;
    readonly committedSteps: number;
    readonly refusals: readonly string[];
  };
}

/**
 * The deterministic interleaving executor over the pure reference machine.
 * Each barrier phase names the lanes granted the barrier: every granted
 * lane applies its next step (in lane order) and a phase may grant at most
 * `concurrencyCap` lanes - the barrier DATA is the scheduler, the cap is
 * enforced structurally, and the observed in-flight peak is reported.
 */
export function runConcurrencyDriver(
  scenario: ConcurrencyDriverScenario,
  seed = 20260825,
): {
  world: KernelWorld;
  peakInFlight: number;
  committedSteps: number;
  refusals: TypedRefusal[];
  inFlightTrace: readonly number[];
} {
  const world = createWorld(seed);
  const cursors = scenario.streams.map(() => 0);
  let current = world;
  let peak = 0;
  let committed = 0;
  const refusals: TypedRefusal[] = [];
  const inFlightTrace: number[] = [];

  for (const phase of scenario.barrierPhases) {
    const granted = [...new Set(phase)];
    if (granted.length > scenario.concurrencyCap) {
      throw new Error(`concurrency driver ${scenario.id}: barrier phase grants ${granted.length} lanes above the cap ${scenario.concurrencyCap}`);
    }
    const active = granted.filter((lane) => cursors[lane] < scenario.streams[lane].length);
    inFlightTrace.push(active.length);
    peak = Math.max(peak, active.length);
    for (const lane of active) {
      const step = scenario.streams[lane][cursors[lane]];
      const applied = applyCommand(current, step);
      if ((applied.outcome as TypedRefusal).refused === true) {
        refusals.push(applied.outcome as TypedRefusal);
        continue;
      }
      if (!(applied.outcome as { replayed?: boolean }).replayed) {
        current = applied.world;
        committed += 1;
      }
      cursors[lane] += 1;
    }
  }
  return { world: current, peakInFlight: peak, committedSteps: committed, refusals, inFlightTrace };
}

/** External evidence shim for pure-model worlds that need Input facts. */
export function externalInputEvidence(): EvidenceFact[] {
  return [
    { kind: 'CheckPlan', ref: 'evidence:CheckPlan#external', producer: 'external-input' },
    { kind: 'ProductVerificationEvidence', ref: 'evidence:ProductVerificationEvidence#external', producer: 'external-input' },
    { kind: 'ProductVerificationFailure', ref: 'evidence:ProductVerificationFailure#external', producer: 'external-input' },
  ];
}
