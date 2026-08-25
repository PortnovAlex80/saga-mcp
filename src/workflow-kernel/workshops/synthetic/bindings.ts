/**
 * workflow-kernel/workshops/synthetic/bindings.ts - the role bindings of
 * the synthetic report-generator workshop (WP-11V): compiled through the
 * SAME one WP-17 compilation path over rows that validate against the
 * SAME frozen schema - the proof that a new workshop is admitted as
 * manifest DATA, not as kernel code.
 *
 * Binding discipline:
 *   - the launch kinds live in the synthetic workshop's own namespace
 *     (reporting.implementation.author / .reviewer) and satisfy the frozen
 *     launch-kind pattern of $defs/ManifestBinding;
 *   - the lifecycle family class field of the rows is READ from the frozen
 *     installed manifest's own exemplar row (a report generator is a
 *     documentation-class cell producer) - never restated as a source
 *     literal, so the kernel-scope name-literal dimension stays zero;
 *   - the D4 certifier is the SAME frozen lifecycle operator contract
 *     (workshop-independent: the certification command is owned by the
 *     lifecycle aggregate, and the synthetic workshop re-uses it without
 *     any change);
 *   - a row outside the frozen schema enum (an invented family name) fails
 *     the compile typed - that is the synthetic kernel-modification
 *     mutation, and it is refused here exactly as it would be in
 *     production admission.
 *
 * PURITY: pure functions over the compiled corpus. No I/O, no session.
 */

import { sha256OfCanonical } from '../../domain/digest.js';
import type { CanonicalRoleContract } from '../../domain/types.js';
import { compileCertifierOperatorContract, compileRoleContract, installedRoleContractManifest } from '../../roles/compiler.js';
import type { CompileRoleContractInput } from '../../roles/compiler.js';
import type { CertifierOperatorContract, ManifestBindingRow } from '../../roles/shapes.js';
import { buildCertifierOperatorFixture } from '../../roles/fixtures/index.js';
import { syntheticCompletionCommandSchema, syntheticProductContractRef, syntheticPromptBudgetStandIn, syntheticRouteTable, syntheticSkill, syntheticTrackerProfile } from '../../roles/fixtures/support.js';
import { RoleContractRuntime } from '../../development/role-contract-runtime.js';
import type { ResolvedRoleSlot } from '../../development/role-contract-runtime.js';

/** The synthetic workshop's own launch-kind namespace (frozen-pattern compliant). */
export const REPORTING_AUTHOR_LAUNCH_KIND = 'reporting.implementation.author';
export const REPORTING_REVIEWER_LAUNCH_KIND = 'reporting.implementation.reviewer';

/**
 * The lifecycle family class of the synthetic rows, read from the frozen
 * manifest's own documentation-class exemplar row (single source; a bare
 * family-name literal never appears in kernel-scope source).
 */
export function reportingWorkshopClass(): string {
  const exemplar = installedRoleContractManifest().bindings.find((row) => row.launchKind === 'documentation.implementation.author');
  if (exemplar === undefined) {
    throw new Error('SYNTHETIC_BINDING_INCOMPLETE: the frozen installed manifest holds no documentation-class exemplar row');
  }
  return exemplar.workshop;
}

/** The synthetic workshop's own manifest binding rows (data; schema-validated at compile). */
export function reportingManifestRows(): readonly ManifestBindingRow[] {
  const workshopClass = reportingWorkshopClass();
  return [
    {
      launchKind: REPORTING_AUTHOR_LAUNCH_KIND,
      bindingClass: 'workplace',
      workshop: workshopClass,
      cellKind: 'implementation',
      protocolRole: 'author',
      semanticProfile: 'implementer',
      slot: { roleContractRef: 'ek8:pending:reporting.implementation.author', contractDigest: 'pending-ek8' },
    },
    {
      launchKind: REPORTING_REVIEWER_LAUNCH_KIND,
      bindingClass: 'workplace',
      workshop: workshopClass,
      cellKind: 'implementation',
      protocolRole: 'reviewer',
      semanticProfile: 'reviewer',
      slot: { roleContractRef: 'ek8:pending:reporting.implementation.reviewer', contractDigest: 'pending-ek8' },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The compile inputs                                                  */
/* ------------------------------------------------------------------ */

/** The author compile input: report-rendering semantics over the same frozen shapes. */
export function reportingAuthorCompileInput(): CompileRoleContractInput {
  const [binding] = reportingManifestRows();
  const semanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1' as const,
    profileId: 'implementer' as const,
    definitionSummary: 'Renders dataset snapshots into report products against pinned product contracts.',
  };
  const protocolSkill = syntheticSkill('synthetic-protocol-reporting-author', 'Synthetic cognition-only execution-protocol instructions for the reporting author.');
  const semanticSkill = syntheticSkill('synthetic-semantic-reporting-author', 'Render the dataset into the report skeleton; cite every section ref; never invent a section.');
  const executorRoutePolicyTable = syntheticRouteTable('synthetic.route-table.reporting-author', REPORTING_AUTHOR_LAUNCH_KIND, 'synthetic-model-report');
  const completionCommandSchema = syntheticCompletionCommandSchema('reportDigest');
  const trackerProjectionProfile = syntheticTrackerProfile('synthetic.tracker.reporting-author', 'Reporting author', 'in-progress');
  const promptBudgetProfile = syntheticPromptBudgetStandIn('reporting-author');
  return {
    binding,
    content: {
      schemaVersion: 'ek.canonical-role-contract.ek1.v1',
      protocolRole: binding.protocolRole,
      semanticProfileRef: `sha256:${sha256OfCanonical(semanticProfileArtifact)}`,
      protocolSkillRef: `sha256:${sha256OfCanonical(protocolSkill)}`,
      protocolSkillDigest: sha256OfCanonical(protocolSkill),
      semanticSkillRef: `sha256:${sha256OfCanonical(semanticSkill)}`,
      semanticSkillDigest: sha256OfCanonical(semanticSkill),
      executorRoutePolicyRef: `sha256:${sha256OfCanonical(executorRoutePolicyTable)}`,
      executorRoutePolicyDigest: sha256OfCanonical(executorRoutePolicyTable),
      allowedCapabilityRefs: ['cognition.provider-request', 'material.read', 'material.write'],
      allowedToolRefs: ['tool:read-dataset', 'tool:render-section', 'tool:verify-report'],
      inputProductContracts: [syntheticProductContractRef('dataset-snapshot-contract.v0')],
      outputProductContracts: [syntheticProductContractRef('report-draft-contract.v0')],
      evidenceObligations: ['obligation:submitContribution'],
      completionCommandSchemaRef: `sha256:${sha256OfCanonical(completionCommandSchema)}`,
      completionCommandSchemaDigest: sha256OfCanonical(completionCommandSchema),
      trackerProjectionProfileRef: `sha256:${sha256OfCanonical(trackerProjectionProfile)}`,
      trackerProjectionProfileDigest: sha256OfCanonical(trackerProjectionProfile),
      promptBudgetProfileRef: `sha256:${sha256OfCanonical(promptBudgetProfile)}`,
      promptBudgetProfileDigest: sha256OfCanonical(promptBudgetProfile),
    },
    artifacts: {
      semanticProfileArtifact,
      protocolSkill,
      semanticSkill,
      executorRoutePolicyTable,
      completionCommandSchema,
      trackerProjectionProfile,
      promptBudgetProfile,
    },
  };
}

/** The reviewer compile input: report-verification semantics. */
export function reportingReviewerCompileInput(): CompileRoleContractInput {
  const binding = reportingManifestRows()[1];
  const semanticProfileArtifact = {
    schemaVersion: 'ek.semantic-profile.ek1.v1' as const,
    profileId: 'reviewer' as const,
    definitionSummary: 'Verifies report drafts against the dataset digest and section coverage.',
  };
  const protocolSkill = syntheticSkill('synthetic-protocol-reporting-reviewer', 'Synthetic cognition-only execution-protocol instructions for the reporting reviewer.');
  const semanticSkill = syntheticSkill('synthetic-semantic-reporting-reviewer', 'Check the draft against the dataset digest and the section refs; return one frozen verdict.');
  const executorRoutePolicyTable = syntheticRouteTable('synthetic.route-table.reporting-reviewer', REPORTING_REVIEWER_LAUNCH_KIND, 'synthetic-model-report');
  const completionCommandSchema = syntheticCompletionCommandSchema('verdictRef');
  const trackerProjectionProfile = syntheticTrackerProfile('synthetic.tracker.reporting-reviewer', 'Reporting reviewer', 'review');
  const promptBudgetProfile = syntheticPromptBudgetStandIn('reporting-reviewer');
  return {
    binding,
    content: {
      schemaVersion: 'ek.canonical-role-contract.ek1.v1',
      protocolRole: binding.protocolRole,
      semanticProfileRef: `sha256:${sha256OfCanonical(semanticProfileArtifact)}`,
      protocolSkillRef: `sha256:${sha256OfCanonical(protocolSkill)}`,
      protocolSkillDigest: sha256OfCanonical(protocolSkill),
      semanticSkillRef: `sha256:${sha256OfCanonical(semanticSkill)}`,
      semanticSkillDigest: sha256OfCanonical(semanticSkill),
      executorRoutePolicyRef: `sha256:${sha256OfCanonical(executorRoutePolicyTable)}`,
      executorRoutePolicyDigest: sha256OfCanonical(executorRoutePolicyTable),
      allowedCapabilityRefs: ['cognition.provider-request', 'material.read'],
      allowedToolRefs: ['tool:read-dataset', 'tool:verify-report'],
      inputProductContracts: [syntheticProductContractRef('report-draft-contract.v0')],
      outputProductContracts: [syntheticProductContractRef('report-verdict-contract.v0')],
      evidenceObligations: ['obligation:submitContribution'],
      completionCommandSchemaRef: `sha256:${sha256OfCanonical(completionCommandSchema)}`,
      completionCommandSchemaDigest: sha256OfCanonical(completionCommandSchema),
      trackerProjectionProfileRef: `sha256:${sha256OfCanonical(trackerProjectionProfile)}`,
      trackerProjectionProfileDigest: sha256OfCanonical(trackerProjectionProfile),
      promptBudgetProfileRef: `sha256:${sha256OfCanonical(promptBudgetProfile)}`,
      promptBudgetProfileDigest: sha256OfCanonical(promptBudgetProfile),
    },
    artifacts: {
      semanticProfileArtifact,
      protocolSkill,
      semanticSkill,
      executorRoutePolicyTable,
      completionCommandSchema,
      trackerProjectionProfile,
      promptBudgetProfile,
    },
  };
}

/* ------------------------------------------------------------------ */
/* The compiled bindings                                               */
/* ------------------------------------------------------------------ */

export interface ReportingBindings {
  readonly author: CanonicalRoleContract;
  readonly reviewer: CanonicalRoleContract;
  readonly certifier: CertifierOperatorContract;
  readonly workshopClass: string;
}

export type ReportingBindingOutcome =
  | { readonly bound: true; readonly value: ReportingBindings }
  | { readonly refused: true; readonly detail: string };

/** Compile the synthetic workshop's bindings (the same one path; typed failures). */
export function compileReportingBindings(): ReportingBindingOutcome {
  const author = compileRoleContract(reportingAuthorCompileInput());
  if (!author.compiled) {
    return { refused: true, detail: `reporting author contract compile failed: ${author.errors.join('; ')}` };
  }
  const reviewer = compileRoleContract(reportingReviewerCompileInput());
  if (!reviewer.compiled) {
    return { refused: true, detail: `reporting reviewer contract compile failed: ${reviewer.errors.join('; ')}` };
  }
  const certifier = compileCertifierOperatorContract(buildCertifierOperatorFixture());
  if (!certifier.compiled) {
    return { refused: true, detail: `certifier operator contract compile failed: ${certifier.errors.join('; ')}` };
  }
  return {
    bound: true,
    value: {
      author: author.contract,
      reviewer: reviewer.contract,
      certifier: certifier.contract,
      workshopClass: reportingWorkshopClass(),
    },
  };
}

/** The role-contract runtime of the synthetic workshop (resolved once per launch kind). */
export function reportingRoleRuntime(bindings: ReportingBindings): { readonly runtime: RoleContractRuntime; readonly authorSlot: ResolvedRoleSlot; readonly reviewerSlot: ResolvedRoleSlot } {
  const runtime = new RoleContractRuntime([
    { launchKind: REPORTING_AUTHOR_LAUNCH_KIND, contract: bindings.author },
    { launchKind: REPORTING_REVIEWER_LAUNCH_KIND, contract: bindings.reviewer },
  ]);
  const authorResolution = runtime.resolveOnce(REPORTING_AUTHOR_LAUNCH_KIND);
  const reviewerResolution = runtime.resolveOnce(REPORTING_REVIEWER_LAUNCH_KIND);
  const refused = 'refused' in authorResolution ? authorResolution : 'refused' in reviewerResolution ? reviewerResolution : undefined;
  if (refused !== undefined) {
    throw new Error(`REPORTING_ROLE_RESOLUTION_REFUSED: ${refused.reason}: ${refused.detail}`);
  }
  if (!('slot' in authorResolution) || !('slot' in reviewerResolution)) {
    throw new Error('REPORTING_ROLE_RESOLUTION_REFUSED: a launch kind resolved without a slot');
  }
  return { runtime, authorSlot: authorResolution.slot, reviewerSlot: reviewerResolution.slot };
}
