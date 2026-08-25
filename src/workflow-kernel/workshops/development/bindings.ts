/**
 * workflow-kernel/workshops/development/bindings.ts - the REAL workshop
 * CanonicalRoleContract bindings of the converted Development workshop
 * (WP-11V, plan EK-8): author, reviewer and certifier over the ACTUAL
 * compiled role contracts, with exact role-universe equality against the
 * frozen installed manifest and the pre-cutover digest-consensus proof
 * (dispatcher, runner and tracker see the SAME frozen pin/digest pair).
 *
 * Laws implemented here:
 *   - The workshop binds compiled contracts through the ONE compilation
 *     path (roles/compiler) over launch kinds that EXIST as rows of the
 *     frozen installed manifest; an unknown launch kind, a row drift or a
 *     compile failure is a typed refusal - never a fallback contract.
 *   - EXACT role-universe equality: the workshop's declared protocol roles
 *     and semantic profiles equal the frozen manifest's roleUniverse sets
 *     exactly (no extra, no missing, no reclassification).
 *   - The certifier binds the frozen D4 operator contract (the certifier
 *     has NO CanonicalRoleContract and is never an author/reviewer kernel
 *     role); its evidence obligation is the frozen
 *     obligation:verifyTerminalClaims owned by lifecycleRun.verifyTerminalClaims.
 *   - CONSENSUS: every consumer view (dispatcher, runner, prompt-builder,
 *     tracker) derives from the SAME resolved slot - same pin OBJECT and
 *     same digest - through the WP-08 role-contract runtime; the
 *     resolution count stays one per launch kind (no re-resolution).
 *
 * PURITY: pure functions over the compiled corpus. No I/O, no session.
 */

import type {
  CanonicalRoleContract,
  CanonicalRoleContractReference,
  ProtocolRole,
  SemanticProfile,
} from '../../domain/types.js';
import { compileCertifierOperatorContract, compileRoleContract, installedRoleContractManifest, manifestBindingByLaunchKind } from '../../roles/compiler.js';
import type { CertifierOperatorContract } from '../../roles/shapes.js';
import { buildCertifierOperatorFixture, certifierOperatorLaunchKind, buildImplementerFixture, buildReviewerFixture, implementerLaunchKind, reviewerLaunchKind } from '../../roles/fixtures/index.js';
import { RoleContractRuntime } from '../../development/role-contract-runtime.js';
import type { ResolvedRoleSlot, RolePinView } from '../../development/role-contract-runtime.js';
import { assertObligationKindsInstalled } from './installation.js';
import type { ObligationKindAssertion } from './installation.js';

/* ------------------------------------------------------------------ */
/* Typed binding refusals (closed set)                                 */
/* ------------------------------------------------------------------ */

export type RoleBindingRefusalCode =
  | 'CONTRACT_COMPILE_FAILED'
  | 'LAUNCH_KIND_OUTSIDE_MANIFEST'
  | 'ROLE_UNIVERSE_MISMATCH'
  | 'CERTIFIER_BINDING_MISMATCH'
  | 'EVIDENCE_OBLIGATION_OUTSIDE_UNIVERSE';

export interface RoleBindingRefusal {
  readonly refused: true;
  readonly code: RoleBindingRefusalCode;
  readonly detail: string;
}

export type RoleBindingOutcome<T> = { readonly bound: true; readonly value: T } | RoleBindingRefusal;

function bindingRefused(code: RoleBindingRefusalCode, detail: string): RoleBindingRefusal {
  return { refused: true, code, detail };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/* ------------------------------------------------------------------ */
/* The real bindings                                                   */
/* ------------------------------------------------------------------ */

/** The compiled real contracts of the workshop (author, reviewer, D4 certifier). */
export interface DevelopmentWorkshopContracts {
  readonly author: CanonicalRoleContract;
  readonly reviewer: CanonicalRoleContract;
  readonly certifier: CertifierOperatorContract;
  readonly launchKinds: {
    readonly author: typeof implementerLaunchKind;
    readonly reviewer: typeof reviewerLaunchKind;
    readonly certifier: typeof certifierOperatorLaunchKind;
  };
}

/**
 * Compile the REAL contracts of the workshop over its frozen manifest
 * rows: the implementer-profile author contract, the reviewer-profile
 * reviewer contract and the D4 certifier operator contract. The compile is
 * the one WP-17 path; every failure is typed.
 */
export function compileDevelopmentContracts(): RoleBindingOutcome<DevelopmentWorkshopContracts> {
  const author = compileRoleContract(buildImplementerFixture());
  if (!author.compiled) {
    return bindingRefused('CONTRACT_COMPILE_FAILED', `author contract compile failed: ${author.errors.join('; ')}`);
  }
  const reviewer = compileRoleContract(buildReviewerFixture());
  if (!reviewer.compiled) {
    return bindingRefused('CONTRACT_COMPILE_FAILED', `reviewer contract compile failed: ${reviewer.errors.join('; ')}`);
  }
  const certifier = compileCertifierOperatorContract(buildCertifierOperatorFixture());
  if (!certifier.compiled) {
    return bindingRefused('CONTRACT_COMPILE_FAILED', `certifier operator contract compile failed: ${certifier.errors.join('; ')}`);
  }
  return {
    bound: true,
    value: {
      author: author.contract,
      reviewer: reviewer.contract,
      certifier: certifier.contract,
      launchKinds: {
        author: implementerLaunchKind,
        reviewer: reviewerLaunchKind,
        certifier: certifierOperatorLaunchKind,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Exact role-universe equality                                        */
/* ------------------------------------------------------------------ */

/** The workshop's declared role universe (what its cells may ever bind). */
export interface WorkshopRoleUniverse {
  readonly protocolRoles: readonly ProtocolRole[];
  readonly semanticProfiles: readonly SemanticProfile[];
  readonly launchKinds: readonly string[];
}

/** The universe the workshop declares (the two kernel protocol roles x the four semantic profiles, bound at its three launch kinds). */
export function developmentRoleUniverse(): WorkshopRoleUniverse {
  return {
    protocolRoles: ['author', 'reviewer'],
    semanticProfiles: ['planner', 'implementer', 'reviewer', 'certifier'],
    launchKinds: [implementerLaunchKind, reviewerLaunchKind, certifierOperatorLaunchKind],
  };
}

export type RoleUniverseAssertion =
  | { readonly equal: true; readonly manifest: { readonly protocolRoles: readonly string[]; readonly semanticProfiles: readonly string[] }; readonly detail: string }
  | RoleBindingRefusal;

/**
 * Require EXACT role-universe equality: the workshop's declared protocol
 * roles and semantic profiles equal the frozen installed manifest's
 * roleUniverse sets exactly, every Workplace launch kind is a manifest row
 * whose protocol role and semantic profile match the compiled contract,
 * and the single D4 certifier operator row owns the frozen certification
 * command. Any drift (an invented role, a dropped profile, a foreign
 * launch kind, a re-keyed row) is a typed refusal.
 */
export function assertExactRoleUniverse(contracts: DevelopmentWorkshopContracts): RoleUniverseAssertion {
  const manifest = installedRoleContractManifest();
  const manifestUniverse = manifest.roleUniverse as {
    readonly protocolRoles: readonly string[];
    readonly semanticProfiles: readonly string[];
  };
  const declared = developmentRoleUniverse();

  if (!sameSet(declared.protocolRoles as readonly string[], manifestUniverse.protocolRoles)) {
    return bindingRefused('ROLE_UNIVERSE_MISMATCH', `the workshop protocol roles [${declared.protocolRoles.join(', ')}] must equal the frozen manifest universe [${manifestUniverse.protocolRoles.join(', ')}] exactly`);
  }
  if (!sameSet(declared.semanticProfiles as readonly string[], manifestUniverse.semanticProfiles)) {
    return bindingRefused('ROLE_UNIVERSE_MISMATCH', `the workshop semantic profiles [${declared.semanticProfiles.join(', ')}] must equal the frozen manifest universe [${manifestUniverse.semanticProfiles.join(', ')}] exactly`);
  }

  // Every Workplace launch kind is a manifest row consistent with its contract.
  const workplaceBindings: readonly { readonly launchKind: string; readonly contract: CanonicalRoleContract; readonly profile: string }[] = [
    { launchKind: contracts.launchKinds.author, contract: contracts.author, profile: 'implementer' },
    { launchKind: contracts.launchKinds.reviewer, contract: contracts.reviewer, profile: 'reviewer' },
  ];
  for (const binding of workplaceBindings) {
    const row = manifestBindingByLaunchKind(binding.launchKind);
    if (row === undefined) {
      return bindingRefused('LAUNCH_KIND_OUTSIDE_MANIFEST', `launch kind ${binding.launchKind} has no row in the frozen installed manifest; a workshop never invents a binding row`);
    }
    if (row.protocolRole !== binding.contract.protocolRole || row.semanticProfile !== binding.profile) {
      return bindingRefused('ROLE_UNIVERSE_MISMATCH', `manifest row ${binding.launchKind} binds (${row.protocolRole}, ${row.semanticProfile}) but the compiled contract declares (${binding.contract.protocolRole}, ${binding.profile})`);
    }
  }

  // The single D4 certifier operator row owns the frozen certification command.
  const operatorRow = manifest.operatorContracts[0];
  if (
    operatorRow === undefined
    || operatorRow.launchKind !== contracts.launchKinds.certifier
    || operatorRow.ownerAggregate !== contracts.certifier.ownerAggregate
    || operatorRow.ownedCommand !== contracts.certifier.ownedCommand
  ) {
    return bindingRefused('CERTIFIER_BINDING_MISMATCH', 'the frozen manifest must hold exactly one lifecycle-operator row binding the certification command (D4)');
  }

  // Every evidence obligation the contracts name is a frozen obligation kind.
  const obligationAssertion: ObligationKindAssertion = assertObligationKindsInstalled(
    [...contracts.author.evidenceObligations, ...contracts.reviewer.evidenceObligations, ...contracts.certifier.evidenceObligations],
    'workshop:development role contracts',
  );
  if ('refused' in obligationAssertion) {
    return { ...obligationAssertion, code: 'EVIDENCE_OBLIGATION_OUTSIDE_UNIVERSE' };
  }

  return {
    equal: true,
    manifest: { protocolRoles: [...manifestUniverse.protocolRoles], semanticProfiles: [...manifestUniverse.semanticProfiles] },
    detail: `exact role-universe equality over ${declared.protocolRoles.length} protocol roles x ${declared.semanticProfiles.length} semantic profiles; ${workplaceBindings.length} Workplace launch kinds and 1 D4 certifier operator binding`,
  };
}

/* ------------------------------------------------------------------ */
/* The pre-cutover digest consensus (dispatcher/runner/tracker)        */
/* ------------------------------------------------------------------ */

/** One consumer's view row of the consensus proof. */
export interface BindingConsensusRow {
  readonly consumer: RolePinView['consumer'];
  readonly launchKind: string;
  readonly roleContractRef: string;
  readonly roleContractDigest: string;
  /** True iff the view carries the SAME pin object as the resolved slot (identity-stable). */
  readonly samePinObject: boolean;
}

export interface BindingConsensus {
  readonly launchKind: string;
  readonly protocolRole: ProtocolRole;
  readonly consumers: readonly BindingConsensusRow[];
  readonly resolutionCount: number;
  readonly consensusHolds: boolean;
}

export type ConsensusOutcome = RoleBindingOutcome<readonly BindingConsensus[]>;

/**
 * Prove dispatcher, runner, prompt-builder and tracker see the SAME frozen
 * reference/digest pair before any cutover: resolve each Workplace launch
 * kind EXACTLY ONCE in the WP-08 runtime, derive all four consumer views,
 * and require same-digest AND same-pin-object for every view.
 */
export function bindingConsensus(contracts?: DevelopmentWorkshopContracts): ConsensusOutcome {
  let value: DevelopmentWorkshopContracts;
  if (contracts === undefined) {
    const compiled = compileDevelopmentContracts();
    if ('refused' in compiled) {
      return compiled;
    }
    value = compiled.value;
  } else {
    value = contracts;
  }
  const { author, reviewer, launchKinds } = value;
  const runtime = new RoleContractRuntime([
    { launchKind: launchKinds.author, contract: author },
    { launchKind: launchKinds.reviewer, contract: reviewer },
  ]);
  const consensus: BindingConsensus[] = [];
  for (const launchKind of [launchKinds.author, launchKinds.reviewer] as const) {
    const resolution = runtime.resolveOnce(launchKind);
    if ('refused' in resolution) {
      return bindingRefused('CONTRACT_COMPILE_FAILED', `launch kind ${launchKind} failed its one resolution: ${resolution.reason}: ${resolution.detail}`);
    }
    const slot: ResolvedRoleSlot = resolution.slot;
    const views: readonly RolePinView[] = [
      runtime.dispatcherView(slot),
      runtime.runnerView(slot),
      runtime.promptBuilderView(slot),
      runtime.trackerView(slot),
    ];
    const rows: BindingConsensusRow[] = views.map((view) => ({
      consumer: view.consumer,
      launchKind: view.launchKind,
      roleContractRef: view.roleContractRef,
      roleContractDigest: view.roleContractDigest,
      samePinObject: view.pin === slot.pin,
    }));
    const consensusHolds = rows.every((row) => row.samePinObject && row.roleContractDigest === slot.pin.roleContractDigest && row.roleContractRef === slot.pin.roleContractRef);
    consensus.push({
      launchKind,
      protocolRole: slot.protocolRole,
      consumers: rows,
      resolutionCount: runtime.resolutionCount,
      consensusHolds,
    });
  }
  if (consensus.some((entry) => !entry.consensusHolds)) {
    return bindingRefused('ROLE_UNIVERSE_MISMATCH', 'the consumer views disagree on the pinned role-contract digest; the cutover is blocked until every consumer sees the same frozen pair');
  }
  return { bound: true, value: consensus };
}

/** The pinned reference/digest pair a WorkIntent/ActivityAttempt carries for a launch kind (the exact pin, resolved once). */
export function pinOfLaunchKind(contracts: DevelopmentWorkshopContracts, launchKind: string): CanonicalRoleContractReference | undefined {
  const runtime = new RoleContractRuntime([
    { launchKind: contracts.launchKinds.author, contract: contracts.author },
    { launchKind: contracts.launchKinds.reviewer, contract: contracts.reviewer },
  ]);
  const resolution = runtime.resolveOnce(launchKind);
  return 'refused' in resolution ? undefined : resolution.slot.pin;
}
