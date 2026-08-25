/**
 * workflow-kernel/roles/compiler.ts - the CanonicalRoleContract compiler
 * (WP-17): the ONE compilation path from a frozen manifest binding row plus
 * contract content into the kernel domain's CanonicalRoleContract type.
 *
 * Law (plan "Canonical role contract" + ROLE-CONTRACT-SPEC.md):
 *   - The contractDigest is computed with the SAME canonical rule as
 *     ../domain/digest.ts (imported, never reimplemented): sha256 over the
 *     canonical JSON of the contract minus {contractDigest, roleContractRef}.
 *   - The contract is validated against the FROZEN schema document
 *     (canonical-role-contract.schema.json, loaded from docs/ - the single
 *     source of truth) before it can be compiled.
 *   - roleContractRef is DERIVED: "sha256:" + contractDigest. A declared
 *     self-address that disagrees with the computed one fails the compile.
 *   - The compile produces the exact reference/digest pair that WorkIntent
 *     and ActivityAttempt pin (pinRoleContract of ../domain/digest.ts).
 *   - Every compilation failure returns typed errors - there is no
 *     substitute selection path, no secondary candidate, no retry with a
 *     loosened shape.
 *
 * Certifier (frozen decision D4): the certifier semantic profile has NO
 * CanonicalRoleContract. Every schema-valid Workplace manifest row binds
 * planner/implementer/reviewer only, and the compiler cross-checks the
 * binding's semanticProfile against the referenced SemanticProfileArtifact,
 * so a certifier-profile contract cannot pass the Workplace path. It is
 * compiled instead as the pinned CertifierOperatorContract via
 * compileCertifierOperatorContract (resolved by its owning obligation, not
 * by workplace.admitWorkIntent).
 *
 * PURITY: imports only ../domain/* (pure kernel) and sibling modules of
 * this package; node builtins via ./frozen-docs.js only.
 */

import {
  digestExcluding,
  pinRoleContract,
  sha256OfCanonical,
} from '../domain/digest.js';
import type {
  CanonicalRoleContract,
  CanonicalRoleContractReference,
  ProtocolRole,
  SemanticProfile,
} from '../domain/types.js';
import { loadFrozenRoleContractSchema, loadRoleContractManifest } from './frozen-docs.js';
import { validateAgainstDef, validateSchema } from './schema-subset.js';
import type {
  CertifierOperatorContract,
  CompletionCommandSchemaArtifact,
  ExecutorRoutePolicyTable,
  ManifestBindingRow,
  OperatorContractBindingRow,
  RoleContractManifestDocument,
  SemanticProfileArtifact,
  SkillArtifact,
  TrackerProjectionProfile,
} from './shapes.js';

/* ------------------------------------------------------------------ */
/* Compiler input/output types                                         */
/* ------------------------------------------------------------------ */

/**
 * Contract content as authored: the 20 non-derived schema fields, optionally
 * carrying a declared self-address (roleContractRef/contractDigest). When
 * declared, both must equal the computed values or the compile fails.
 *
 * NOTE on the domain type: CanonicalRoleContract inherits the pin alias
 * `roleContractDigest` (the WorkIntent-visible name of the slot
 * fingerprint). The authored and compiled ARTIFACT is schema-shaped - 22
 * physical properties, no alias property at runtime - exactly like the
 * WP-05 domain tests build contract values; the alias is carried by the
 * returned pin, not by the artifact object.
 */
export type RoleContractContent = Omit<
  CanonicalRoleContract,
  'roleContractRef' | 'roleContractDigest' | 'contractDigest'
> & {
  readonly roleContractRef?: string;
  readonly contractDigest?: string;
};

/**
 * The artifacts the contract's content-addressed pairs point at. The
 * compiler validates each against its frozen $def and verifies the paired
 * digest (ref === "sha256:"+digest === sha256(canonicalJson(artifact))).
 */
export interface RoleContractArtifacts {
  readonly semanticProfileArtifact: SemanticProfileArtifact;
  readonly protocolSkill: SkillArtifact;
  readonly semanticSkill: SkillArtifact;
  readonly executorRoutePolicyTable: ExecutorRoutePolicyTable;
  readonly completionCommandSchema: CompletionCommandSchemaArtifact;
  readonly trackerProjectionProfile: TrackerProjectionProfile;
  /**
   * Shape frozen by WP-16 part 3 (prompt-budget-profile.schema.json), not by
   * this schema; therefore only the paired digest is verified here.
   */
  readonly promptBudgetProfile?: unknown;
}

/** Certifier operator content as authored (D4). */
export type CertifierOperatorContent = Omit<CertifierOperatorContract, 'operatorContractRef' | 'contractDigest'> & {
  readonly operatorContractRef?: string;
  readonly contractDigest?: string;
};

/**
 * Compile outcome: either the compiled value plus the exact pin WorkIntent
 * and ActivityAttempt carry, or typed errors. Never a partial value, never
 * an alternate candidate.
 */
export type CompileOutcome<T> =
  | { readonly compiled: true; readonly contract: T; readonly pin: CanonicalRoleContractReference }
  | { readonly compiled: false; readonly errors: readonly string[] };

export interface CompileRoleContractInput {
  readonly binding: ManifestBindingRow;
  readonly content: RoleContractContent;
  readonly artifacts: RoleContractArtifacts;
}

export interface CompileCertifierOperatorInput {
  readonly binding: OperatorContractBindingRow;
  readonly content: CertifierOperatorContent;
}

/* ------------------------------------------------------------------ */
/* Shared admission checks                                             */
/* ------------------------------------------------------------------ */

function declaredSelfAddressCheck(
  errors: string[],
  label: string,
  declared: string | undefined,
  computed: string,
  declaredName: string,
): void {
  if (declared !== undefined && declared !== computed) {
    errors.push(`${label}: declared ${declaredName} ${declared} does not equal the computed slot fingerprint ${computed}`);
  }
}

function pairedArtifactCheck(
  errors: string[],
  schema: unknown,
  label: string,
  artifact: unknown,
  defName: string | undefined,
  refValue: string,
  digestValue: string,
): void {
  if (artifact === undefined) {
    errors.push(`${label}: referenced artifact was not provided`);
    return;
  }
  if (defName !== undefined) {
    validateAgainstDef(artifact, schema, defName, label, errors);
  }
  const artifactDigest = sha256OfCanonical(artifact);
  if (refValue !== `sha256:${artifactDigest}`) {
    errors.push(`${label}: ref does not match artifact content address`);
  }
  if (digestValue !== artifactDigest) {
    errors.push(`${label}: paired digest does not verify`);
  }
}

/**
 * Unpaired content-addressed reference check (semanticProfileRef has no
 * digest companion in the frozen shape): the ref must equal the artifact's
 * content address.
 */
function refOnlyArtifactCheck(
  errors: string[],
  label: string,
  refValue: string,
  artifact: unknown,
): void {
  if (artifact === undefined) {
    errors.push(`${label}: referenced artifact was not provided`);
    return;
  }
  if (refValue !== `sha256:${sha256OfCanonical(artifact)}`) {
    errors.push(`${label}: ref does not match artifact content address`);
  }
}

/** The value must be a plain object before any digest/key walk over it. */
function requireObject(errors: string[], label: string, value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label}: must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* The CanonicalRoleContract compiler                                  */
/* ------------------------------------------------------------------ */

/**
 * Compile one manifest binding row + authored contract content into the
 * domain CanonicalRoleContract. The compile is atomic: every check below
 * must pass or nothing is returned.
 *
 * Checks (all fail-closed):
 *   1. the binding row satisfies $defs/ManifestBinding of the frozen schema;
 *   2. the slot fingerprint computes under the ONE canonical rule
 *      (domain/digest.ts) and any declared self-address equals it;
 *   3. the materialized contract satisfies the schema ROOT (frozen closed
 *      field set - additionalProperties:false everywhere);
 *   4. binding.protocolRole === contract.protocolRole;
 *   5. the referenced SemanticProfileArtifact declares the binding's
 *      semanticProfile (the structural certifier exclusion of D4);
 *   6. every referenced artifact satisfies its frozen $def and every paired
 *      ref/digest verifies against the artifact's canonical sha256.
 */
export function compileRoleContract(input: CompileRoleContractInput): CompileOutcome<CanonicalRoleContract> {
  const errors: string[] = [];
  const schema = loadFrozenRoleContractSchema();
  if (!requireObject(errors, 'contract.input', input)) {
    return { compiled: false, errors };
  }
  const { binding, content, artifacts } = input;

  // 0. Totality guards: malformed inputs become typed compile errors, never
  //    crashes and never a partial value.
  if (
    !requireObject(errors, 'contract.binding', binding)
    || !requireObject(errors, 'contract.content', content)
    || !requireObject(errors, 'contract.artifacts', artifacts)
  ) {
    return { compiled: false, errors };
  }

  // 1. The binding row must satisfy the frozen manifest binding shape.
  validateAgainstDef(binding, schema, 'ManifestBinding', 'contract.binding', errors);

  // 2. Slot fingerprint under the ONE canonical rule.
  const computed = digestExcluding(content as object, ['contractDigest', 'roleContractRef']);
  declaredSelfAddressCheck(errors, 'contract', content.contractDigest, computed, 'contractDigest');
  declaredSelfAddressCheck(errors, 'contract', content.roleContractRef, `sha256:${computed}`, 'roleContractRef');

  // 3. The materialized contract against the frozen schema ROOT. The
  //    artifact is schema-shaped (22 physical properties; the domain type's
  //    inherited roleContractDigest pin alias lives on the returned pin).
  const materialized = {
    ...content,
    contractDigest: computed,
    roleContractRef: `sha256:${computed}`,
  } as CanonicalRoleContract;
  validateSchema(materialized, schema, schema, 'contract', errors);

  // 4. Protocol-role consistency between the manifest row and the contract.
  if (binding.protocolRole !== materialized.protocolRole) {
    errors.push(
      `contract.binding: launch kind "${binding.launchKind}" binds protocolRole "${binding.protocolRole}" but the contract declares "${materialized.protocolRole}"`,
    );
  }

  // 5. Semantic-profile consistency: the referenced artifact must declare
  //    the profile the manifest row binds (this is what makes a certifier
  //    contract impossible through the Workplace path - D4).
  const profileArtifact: unknown = artifacts.semanticProfileArtifact;
  validateAgainstDef(profileArtifact, schema, 'SemanticProfileArtifact', 'contract.semanticProfileArtifact', errors);
  if (
    requireObject(errors, 'contract.semanticProfileArtifact', profileArtifact)
    && (profileArtifact as SemanticProfileArtifact).profileId !== binding.semanticProfile
  ) {
    errors.push(
      `contract.semanticProfileArtifact: binding for launch kind "${binding.launchKind}" requires profile "${binding.semanticProfile}", the referenced artifact declares "${(profileArtifact as SemanticProfileArtifact).profileId}"`,
    );
  }
  refOnlyArtifactCheck(errors, 'contract.semanticProfile', materialized.semanticProfileRef, profileArtifact);

  // 6. Referenced artifacts: frozen $defs + paired digests.
  pairedArtifactCheck(
    errors, schema, 'contract.protocolSkill',
    artifacts.protocolSkill, 'SkillArtifact',
    materialized.protocolSkillRef, materialized.protocolSkillDigest,
  );
  pairedArtifactCheck(
    errors, schema, 'contract.semanticSkill',
    artifacts.semanticSkill, 'SkillArtifact',
    materialized.semanticSkillRef, materialized.semanticSkillDigest,
  );
  pairedArtifactCheck(
    errors, schema, 'contract.executorRoutePolicy',
    artifacts.executorRoutePolicyTable, 'ExecutorRoutePolicyTable',
    materialized.executorRoutePolicyRef, materialized.executorRoutePolicyDigest,
  );
  pairedArtifactCheck(
    errors, schema, 'contract.completionCommandSchema',
    artifacts.completionCommandSchema, 'CompletionCommandSchema',
    materialized.completionCommandSchemaRef, materialized.completionCommandSchemaDigest,
  );
  pairedArtifactCheck(
    errors, schema, 'contract.trackerProjectionProfile',
    artifacts.trackerProjectionProfile, 'TrackerProjectionProfile',
    materialized.trackerProjectionProfileRef, materialized.trackerProjectionProfileDigest,
  );
  if (artifacts.promptBudgetProfile !== undefined) {
    pairedArtifactCheck(
      errors, schema, 'contract.promptBudgetProfile',
      artifacts.promptBudgetProfile, undefined,
      materialized.promptBudgetProfileRef, materialized.promptBudgetProfileDigest,
    );
  }

  if (errors.length > 0) return { compiled: false, errors };
  return { compiled: true, contract: materialized, pin: pinRoleContract(materialized) };
}

/* ------------------------------------------------------------------ */
/* The D4 certifier operator-contract compiler                         */
/* ------------------------------------------------------------------ */

/**
 * Compile the pinned CertifierOperatorContract of the certifier semantic
 * profile (frozen decision D4). Same slot-fingerprint discipline with the
 * analogous exclusion of the derived operatorContractRef. Resolved by its
 * owning obligation (obligation:verifyTerminalClaims), never through a
 * Workplace protocol role.
 */
export function compileCertifierOperatorContract(input: CompileCertifierOperatorInput): CompileOutcome<CertifierOperatorContract> {
  const errors: string[] = [];
  const schema = loadFrozenRoleContractSchema();
  if (!requireObject(errors, 'operator.input', input)) {
    return { compiled: false, errors };
  }
  const { binding, content } = input;

  if (!requireObject(errors, 'operator.binding', binding) || !requireObject(errors, 'operator.content', content)) {
    return { compiled: false, errors };
  }

  validateAgainstDef(binding, schema, 'OperatorContractBinding', 'operator.binding', errors);

  const computed = digestExcluding(content as object, ['contractDigest', 'operatorContractRef']);
  declaredSelfAddressCheck(errors, 'operator', content.contractDigest, computed, 'contractDigest');
  declaredSelfAddressCheck(errors, 'operator', content.operatorContractRef, `sha256:${computed}`, 'operatorContractRef');

  const materialized = {
    ...content,
    contractDigest: computed,
    operatorContractRef: `sha256:${computed}`,
  } as CertifierOperatorContract;
  validateAgainstDef(materialized, schema, 'CertifierOperatorContract', 'operator', errors);

  if (binding.ownedCommand !== materialized.ownedCommand || binding.ownerAggregate !== materialized.ownerAggregate) {
    errors.push(
      `operator.binding: the D4 row pins ${binding.ownerAggregate}.${binding.ownedCommand}, the contract declares ${materialized.ownerAggregate}.${materialized.ownedCommand}`,
    );
  }

  if (errors.length > 0) return { compiled: false, errors };
  return {
    compiled: true,
    contract: materialized,
    pin: {
      roleContractRef: materialized.operatorContractRef,
      roleContractDigest: materialized.contractDigest,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Manifest row lookup (closed set; absent row = absent contract)      */
/* ------------------------------------------------------------------ */

/** The installed manifest document (memoized load of the frozen file). */
export function installedRoleContractManifest(): RoleContractManifestDocument {
  return loadRoleContractManifest();
}

/**
 * The Workplace binding row of one launch kind, or undefined when the
 * launch kind is outside the installed table. An absent row means there is
 * NO contract for that launch kind - the caller must refuse, never infer.
 */
export function manifestBindingByLaunchKind(launchKind: string): ManifestBindingRow | undefined {
  return loadRoleContractManifest().bindings.find((row) => row.launchKind === launchKind);
}

/**
 * The single lifecycle operator binding row (the D4 certifier). The frozen
 * manifest admits exactly one; a manifest without it returns undefined and
 * the caller must refuse.
 */
export function certifierOperatorBinding(): OperatorContractBindingRow | undefined {
  return loadRoleContractManifest().operatorContracts[0];
}

/* ------------------------------------------------------------------ */
/* Route-policy selection law (exactly-one-match, decidable)           */
/* ------------------------------------------------------------------ */

/** The three static protocol facts a route rule may condition on. */
export interface RoutePolicyLaunchFacts {
  readonly launchKind: string;
  readonly protocolRole: ProtocolRole;
  readonly semanticProfile: SemanticProfile;
}

/**
 * Number of rules of the table whose `when` conditions all equal the given
 * launch facts (port of the frozen validator's matchingRuleCount). The law:
 * evaluating a table for one launch kind must yield EXACTLY ONE matching
 * rule; zero or two is a typed admission failure at activityAttempt.create.
 */
export function countMatchingRouteRules(table: ExecutorRoutePolicyTable, launch: RoutePolicyLaunchFacts): number {
  const facts: Record<string, unknown> = {
    launchKind: launch.launchKind,
    protocolRole: launch.protocolRole,
    semanticProfile: launch.semanticProfile,
  };
  let count = 0;
  for (const rule of table.rules) {
    const when = rule.when as Record<string, unknown>;
    let matches = true;
    for (const key of Object.keys(when)) {
      if (when[key] !== facts[key]) {
        matches = false;
        break;
      }
    }
    if (matches) count += 1;
  }
  return count;
}
