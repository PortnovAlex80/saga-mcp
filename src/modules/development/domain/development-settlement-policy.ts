/**
 * Deterministic validation and settlement policies for Development.
 *
 * These policies do no I/O and contain no LM decisions. Installation adapters
 * materialize the task graph/worksets/candidate/evidence; the policies only
 * validate immutable snapshots and derive the local process outcome.
 */

import { sha256Hex } from '../../../shared/canonical-json.js';
import { decodeCheckDiagnostic } from '../../../process-modules/domain/workplace/check-diagnostic.js';
import {
  parseRepositoryScope,
  repositoryScopeCovers,
  repositoryScopesOverlap as sharedRepositoryScopesOverlap,
} from '../../../shared/repository-scope.js';
import {
  acceptanceCriterionIdentity,
  ACCEPTANCE_VERIFICATION_SCHEMA,
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_BASELINE_ADOPTION_SCHEMA,
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
  DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
  type AcceptanceVerificationWorkset,
  type ContentAddressedReference,
  type DevelopmentCase,
  type DevelopmentCertificatePayload,
  type DevelopmentDecision,
  type DevelopmentImplementationWorkset,
  type DevelopmentPolicySnapshot,
  type DevelopmentReasonCode,
  type DevelopmentSettlementInput,
  type DevelopmentTaskGraphItem,
  type DevelopmentTaskGraphSnapshot,
  type IntegratedReleaseCandidate,
  type VerifiedIntegrationBundle,
} from './development-schemas.js';

export interface DevelopmentTaskGraphValidationResult {
  valid: boolean;
  reasonCodes: readonly DevelopmentReasonCode[];
  errors: readonly string[];
}

export interface DevelopmentTaskGraphPolicyPort {
  validate(
    developmentCase: DevelopmentCase,
    graph: DevelopmentTaskGraphSnapshot,
  ): DevelopmentTaskGraphValidationResult;
}

export interface DevelopmentSettlementResult {
  decision: DevelopmentDecision;
  reasonCodes: readonly DevelopmentReasonCode[];
  rationale: string;
  /** Hash of the immutable DevelopmentCase (the Process Module input). */
  inputHash: string;
  bundle: VerifiedIntegrationBundle | null;
}

export interface DevelopmentSettlementPolicyPort {
  settle(input: DevelopmentSettlementInput): DevelopmentSettlementResult;
}

function hashWithoutField(value: object, field: string): string {
  const body: Record<string, unknown> = { ...value };
  delete body[field];
  return sha256Hex(body);
}

export function hashDevelopmentTaskGraph(
  graph: DevelopmentTaskGraphSnapshot,
): string {
  return hashWithoutField(graph, 'graphHash');
}

export function hashImplementationWorkset(
  workset: DevelopmentImplementationWorkset,
): string {
  // Explicit projection: callers may carry audit-only execution coordinates
  // from older package snapshots. Unknown/provenance fields must never enter
  // accepted material identity.
  return sha256Hex({
    schemaVersion: workset.schemaVersion,
    taskGraphHash: workset.taskGraphHash,
    results: workset.results.map(item => ({
      key: item.key,
      status: item.status,
      reviewedSourceCommit: item.reviewedSourceCommit,
      result: item.result === null ? null : {
        schema: item.result.schema,
        hash: item.result.hash,
      },
      reasonCodes: item.reasonCodes,
    })),
    complete: workset.complete,
    blockingItemKeys: workset.blockingItemKeys,
  });
}

export function hashIntegratedCandidate(
  candidate: IntegratedReleaseCandidate,
): string {
  // Integration receipt refs are proof/provenance coordinates. Repository
  // commit/tree snapshots already carry the resulting material, so receipt
  // row allocation (and legacy task decoration) cannot change candidate
  // identity.
  return sha256Hex({
    schemaVersion: candidate.schemaVersion,
    taskGraphHash: candidate.taskGraphHash,
    implementationWorksetHash: candidate.implementationWorksetHash,
    repositories: candidate.repositories,
    buildProducts: candidate.buildProducts,
    frozen: candidate.frozen,
    ...(candidate.readiness ? { readiness: candidate.readiness } : {}),
    ...(candidate.sourceCandidate ? { sourceCandidate: candidate.sourceCandidate } : {}),
    ...(candidate.readinessCertification
      ? { readinessCertification: candidate.readinessCertification }
      : {}),
  });
}

export function hashIntegratedSourceCandidate(
  candidate: import('./development-schemas.js').IntegratedSourceCandidate,
): string {
  return sha256Hex({
    schemaVersion: candidate.schemaVersion,
    taskGraphHash: candidate.taskGraphHash,
    implementationWorksetHash: candidate.implementationWorksetHash,
    repositories: candidate.repositories,
    buildProducts: candidate.buildProducts,
    frozen: candidate.frozen,
  });
}

export function hashAcceptanceVerification(
  verification: AcceptanceVerificationWorkset,
): string {
  return sha256Hex({
    schemaVersion: verification.schemaVersion,
    acceptanceBaselineHash: verification.acceptanceBaselineHash,
    candidateHash: verification.candidateHash,
    evidence: verification.evidence.map(item => ({
      verificationItemKey: item.verificationItemKey,
      acceptanceCriterionId: item.acceptanceCriterionId,
      acceptedCriterionHash: item.acceptedCriterionHash,
      candidateHash: item.candidateHash,
      outcome: item.outcome,
      evidence: {
        schema: item.evidence.schema,
        hash: item.evidence.hash,
      },
      provider: {
        name: item.provider.name,
        version: item.provider.version,
        category: item.provider.category,
        trusted: item.provider.trusted,
      },
    })),
    complete: verification.complete,
  });
}

export function hashVerifiedIntegrationBundle(
  bundle: VerifiedIntegrationBundle,
): string {
  return hashWithoutField(bundle, 'bundleHash');
}

export function hashDevelopmentPolicy(
  policy: DevelopmentPolicySnapshot,
): string {
  return hashWithoutField(policy, 'contentHash');
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * The synthetic placeholder the implementation workset builder emits when an
 * item has no matching accepted cell product (status 'blocked', taskId 0,
 * reasonCodes ['accepted-cell-product-missing']). It is a settlement INPUT
 * gap — an honest blocked / implementation-incomplete verdict — never a
 * malformed-workset failure (units epic-8 cert#37, tips epic-5 cert#40 died
 * on `item.taskId <= 0` firing against exactly this placeholder).
 */
function isMissingProductPlaceholder(item: {
  status: string;
  reasonCodes: readonly string[];
}): boolean {
  return item.status === 'blocked'
    && item.reasonCodes.includes('accepted-cell-product-missing');
}

function validRef(reference: ContentAddressedReference): boolean {
  return reference.schema.trim().length > 0
    && reference.ref.trim().length > 0
    && reference.hash.trim().length > 0;
}

function sortedNumbers(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

function sameNumberSet(left: Iterable<number>, right: Iterable<number>): boolean {
  const a = sortedNumbers(left);
  const b = sortedNumbers(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasCycle(items: readonly DevelopmentTaskGraphItem[]): boolean {
  const edges = new Map(items.map(item => [item.key, item.dependsOnKeys]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (key: string): boolean => {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of edges.get(key) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  };

  return items.some(item => visit(item.key));
}

function pushIssue(
  reasons: DevelopmentReasonCode[],
  errors: string[],
  reason: DevelopmentReasonCode,
  message: string,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
  errors.push(message);
}

/**
 * Kernel-side validation of the canonical graph produced from the planner's
 * advisory proposal.
 */
export class ReferenceDevelopmentTaskGraphPolicy
implements DevelopmentTaskGraphPolicyPort {
  validate(
    developmentCase: DevelopmentCase,
    graph: DevelopmentTaskGraphSnapshot,
  ): DevelopmentTaskGraphValidationResult {
    const reasonCodes: DevelopmentReasonCode[] = [];
    const errors: string[] = [];

    if (invalidCase(developmentCase)) {
      pushIssue(
        reasonCodes,
        errors,
        'invalid-input-contract',
        'DevelopmentCase failed contract validation',
      );
    }
    if (graph.schemaVersion !== DEVELOPMENT_TASK_GRAPH_SCHEMA) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-hash-invalid',
        `task graph schema must be ${DEVELOPMENT_TASK_GRAPH_SCHEMA}`,
      );
    }
    if (hashDevelopmentTaskGraph(graph) !== graph.graphHash) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-hash-invalid',
        'task graph hash does not match its canonical body',
      );
    }
    if (
      graph.epicId !== developmentCase.epicId
      || graph.formalizationCertificateHash
        !== developmentCase.formalizationCertificate.hash
      || graph.solutionContractHash !== developmentCase.solutionContract.hash
      || (graph.acceptanceBaselineHash !== undefined
        && graph.acceptanceBaselineHash !== developmentCase.acceptanceBaselineHash)
      || graph.srsHash !== developmentCase.srs.hash
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-lineage-mismatch',
        'task graph is not bound to the exact DevelopmentCase lineage',
      );
    }
    if (
      !validRef(graph.plannerSubmission)
      || ![
        DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
        DEVELOPMENT_BASELINE_ADOPTION_SCHEMA,
      ].includes(graph.plannerSubmission.schema)
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-lineage-mismatch',
        'task graph does not identify an exact planner proposal or authorized baseline adoption',
      );
    }

    const allItems = [
      ...graph.implementationItems,
      ...graph.verificationItems,
    ];
    const itemKeys = allItems.map(item => item.key);
    const itemKeySet = new Set(itemKeys);
    const implementationKeySet = new Set(
      graph.implementationItems.map(item => item.key),
    );
    if (
      !unique(itemKeys)
      || allItems.some(item => !item.key.trim())
      || allItems.some(item =>
        !item.taskKind.trim()
        || !item.executionSkill.trim()
        || !item.executionMode.trim()
        || typeof item.required !== 'boolean'
        || !unique(item.acceptanceCriterionIds)
        || !unique(item.dependsOnKeys)
        || !unique(item.changeScopes)
        || item.changeScopes.some(scope => {
          try {
            parseRepositoryScope(scope);
            return false;
          } catch {
            return true;
          }
        }))
      || allItems.some(item => item.dependsOnKeys.includes(item.key))
      || allItems.some(item =>
        item.dependsOnKeys.some(dependency => !itemKeySet.has(dependency)))
      || graph.implementationItems.some(item =>
        item.dependsOnKeys.some(dependency =>
          !implementationKeySet.has(dependency)))
      || hasCycle(allItems)
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-dependency-invalid',
        'task graph keys/dependencies must be unique, closed, acyclic and non-self-referential',
      );
    }

    if (graph.implementationItems.some(item => item.kind !== 'implementation')) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-dependency-invalid',
        'implementationItems contains a non-implementation item',
      );
    }
    if (
      graph.implementationItems.some(item =>
        !['git_change', 'artifact_change'].includes(item.executionMode)
        || item.projectRepositoryId === null
        || item.changeScopes.length === 0)
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-dependency-invalid',
        'implementation work must use git_change, bind one case repository and declare non-empty change scopes',
      );
    }

    const requiredChangeScopes = developmentCase.policy.requiredChangeScopes ?? [];
    for (const repository of developmentCase.repositories) {
      const repositoryItems = graph.implementationItems.filter(item =>
        item.projectRepositoryId === repository.projectRepositoryId);
      for (const requiredScope of requiredChangeScopes) {
        if (repositoryItems.some(item => item.changeScopes.some(scope =>
          repositoryScopeContains(scope, requiredScope)))) continue;
        pushIssue(
          reasonCodes,
          errors,
          'task-graph-required-scope-missing',
          `repository ${repository.projectRepositoryId} does not assign required change scope '${requiredScope}' to any implementation item`,
        );
      }
    }

    // F-B (Elite-3 post-mortem, operator-corrected): the overlap-ordering
    // RULE is already taught in the planner skill — what failed was the
    // model re-deriving the pairwise matrix over dozens of scopes. Same idiom
    // as the coverage-gap diff: serialize the COMPUTED conflict set so the
    // repair attempt receives every unordered pair (with its overlapping
    // scopes) in one shot instead of discovering pairs one rejection at a
    // time.
    const unorderedOverlapPairs = computeUnorderedOverlapPairs(graph);
    if (unorderedOverlapPairs.length > 0) {
      const pairLines = unorderedOverlapPairs
        .slice(0, 30)
        .map(pair => `'${pair.leftKey}' <-> '${pair.rightKey}' (overlapping scopes: left [${pair.leftScopes.join(', ')}], right [${pair.rightScopes.join(', ')}])`)
        .join('; ');
      const overflowNote = unorderedOverlapPairs.length > 30
        ? `; and ${unorderedOverlapPairs.length - 30} more pair(s)` : '';
      pushIssue(
        reasonCodes,
        errors,
        'implementation-scope-overlap',
        `${unorderedOverlapPairs.length} same-repository implementation item pair(s) overlap without a dependency order — add a dependency path in ONE direction for each computed pair: ${pairLines}${overflowNote}`,
      );
    }
    if (
      graph.verificationItems.some(item =>
        item.kind !== 'verification'
        || item.acceptanceCriterionIds.length !== 1
        || !item.required
        || item.taskKind !== 'verification.ac'
        || item.executionMode !== 'read_only_evidence'
        || !developmentCase.repositories.some(repository =>
          repository.projectRepositoryId === item.projectRepositoryId))
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'verification-plan-coverage-gap',
        'every verification item must be a required read_only_evidence verification.ac task for exactly one acceptance criterion and one case repository',
      );
    }

    const targetSourceKeys = graph.integrationTargets
      .flatMap(target => target.sourceWorkItemKeys);
    const requiredImplementationKeys = graph.implementationItems
      .filter(item => item.required)
      .map(item => item.key);
    if (
      !unique(targetSourceKeys)
      || !sameStringSet(new Set(targetSourceKeys), new Set(requiredImplementationKeys))
      || graph.integrationTargets.some(target =>
        target.sourceWorkItemKeys.some(key =>
          graph.implementationItems.find(item => item.key === key)
            ?.projectRepositoryId !== target.projectRepositoryId))
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'integration-source-partition-invalid',
        'required implementation items must belong to exactly one matching repository integration target',
      );
    }

    const acceptedCriterionIds = new Set(
      developmentCase.acceptanceCriteria.map(acceptanceCriterionIdentity),
    );
    const implementationRequired = new Set(
      developmentCase.acceptanceCriteria
        .filter(criterion => criterion.implementationRequired)
        .map(acceptanceCriterionIdentity),
    );
    const implementationCovered = new Set(
      graph.implementationItems
        .filter(item => item.required)
        .flatMap(item => item.acceptanceCriterionIds),
    );
    const verificationCovered = new Set(
      graph.verificationItems.flatMap(item => item.acceptanceCriterionIds),
    );

    if (
      [...implementationCovered].some(id => !acceptedCriterionIds.has(id))
      || ![...implementationRequired].every(id => implementationCovered.has(id))
    ) {
      // The diff is computable at the source — serialize it into the message.
      // A generic "coverage gap" forces the repair worker to re-derive the
      // missing AC set from scratch on every attempt (observed: P01/counter).
      const missingIds = [...implementationRequired]
        .filter(id => !implementationCovered.has(id));
      const extraIds = [...implementationCovered]
        .filter(id => !acceptedCriterionIds.has(id));
      pushIssue(
        reasonCodes,
        errors,
        'implementation-coverage-gap',
        'required implementation coverage does not equal the accepted AC scope'
        + `; missing AC artifact ids: [${missingIds.sort((left, right) => left - right).join(', ')}]`
        + acCodeLegend(developmentCase, missingIds)
        + `; extra AC artifact ids: [${extraIds.sort((left, right) => left - right).join(', ')}]`
        + acCodeLegend(developmentCase, extraIds),
      );
    }
    // Workshop fix: close the non-required blind spot. Coverage arithmetic
    // above filters by item.required BEFORE the extra-id membership check, so
    // a NON-required item carrying a foreign/invalid AC id passed the gate
    // and only exploded later at kernel materialization
    // (PRODUCTION_CELL_SOURCE_ARTIFACT_INVALID) — violating the cell's own
    // invariant that graph semantics are settled in-cell. ALL implementation
    // items must carry only accepted-case AC ids; the required-coverage
    // arithmetic itself is unchanged.
    const implementationDeclared = new Set(
      graph.implementationItems.flatMap(item => item.acceptanceCriterionIds),
    );
    const declaredExtraIds = [...implementationDeclared]
      .filter(id => !acceptedCriterionIds.has(id))
      .sort((left, right) => left - right);
    if (declaredExtraIds.length > 0) {
      pushIssue(
        reasonCodes,
        errors,
        'implementation-coverage-gap',
        'every implementation item (required or not) must carry only accepted-case AC ids'
        + `; extra AC artifact ids: [${declaredExtraIds.join(', ')}]`
        + acCodeLegend(developmentCase, declaredExtraIds),
      );
    }
    if (
      [...verificationCovered].some(id => !acceptedCriterionIds.has(id))
      || !sameNumberSet(verificationCovered, acceptedCriterionIds)
    ) {
      const missingIds = [...acceptedCriterionIds]
        .filter(id => !verificationCovered.has(id));
      const extraIds = [...verificationCovered]
        .filter(id => !acceptedCriterionIds.has(id));
      pushIssue(
        reasonCodes,
        errors,
        'verification-plan-coverage-gap',
        'the task graph must contain verification work for every accepted AC'
        + `; missing AC artifact ids: [${missingIds.sort((left, right) => left - right).join(', ')}]`
        + acCodeLegend(developmentCase, missingIds)
        + `; extra AC artifact ids: [${extraIds.sort((left, right) => left - right).join(', ')}]`
        + acCodeLegend(developmentCase, extraIds),
      );
    }

    const repositoryById = new Map(
      developmentCase.repositories.map(repository => [
        repository.projectRepositoryId,
        repository,
      ]),
    );
    if (
      !unique(developmentCase.repositories.map(repository =>
        repository.projectRepositoryId))
      || allItems.some(item =>
        item.projectRepositoryId !== null
        && !repositoryById.has(item.projectRepositoryId))
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-lineage-mismatch',
        'task graph references a repository outside the DevelopmentCase',
      );
    }

    const integrationRepositoryIds = graph.integrationTargets.map(target =>
      target.projectRepositoryId);
    if (
      !unique(integrationRepositoryIds)
      || !sameNumberSet(integrationRepositoryIds, repositoryById.keys())
      || graph.integrationTargets.some(target => {
        const repository = repositoryById.get(target.projectRepositoryId);
        return !repository
          || repository.integrationBranch !== target.targetBranch
          || repository.expectedBaseCommit !== target.expectedBaseCommit
          || !unique(target.sourceWorkItemKeys)
          || target.sourceWorkItemKeys.some(key =>
            !graph.implementationItems.some(item =>
              item.key === key && item.required));
      })
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'task-graph-lineage-mismatch',
        'integration targets must exactly match case repositories and implementation work',
      );
    }

    return {
      valid: errors.length === 0,
      reasonCodes,
      errors,
    };
  }
}

export function repositoryScopesOverlap(left: string, right: string): boolean {
  return sharedRepositoryScopesOverlap(left, right);
}

function repositoryScopeContains(scope: string, requiredPath: string): boolean {
  return repositoryScopeCovers(scope, requiredPath);
}

function dependsTransitivelyOn(
  item: DevelopmentTaskGraphItem,
  target: DevelopmentTaskGraphItem,
  allItems: readonly DevelopmentTaskGraphItem[],
): boolean {
  const byKey = new Map(allItems.map(candidate => [candidate.key, candidate]));
  const pending = [...item.dependsOnKeys];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (key === target.key) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(...(byKey.get(key)?.dependsOnKeys ?? []));
  }
  return false;
}

/**
 * F-B — deterministic repair assistance: the complete set of same-repository
 * implementation item pairs whose change scopes overlap while neither
 * transitively depends on the other. The validator serializes this computed
 * conflict set into the rejection so a repair attempt receives every
 * unordered pair in one shot (same idiom as the coverage-gap diff) instead
 * of the model re-deriving the pairwise matrix over dozens of scopes.
 */
export function computeUnorderedOverlapPairs(
  graph: DevelopmentTaskGraphSnapshot,
): Array<{
  leftKey: string;
  rightKey: string;
  leftScopes: readonly string[];
  rightScopes: readonly string[];
}> {
  const pairs: Array<{
    leftKey: string;
    rightKey: string;
    leftScopes: readonly string[];
    rightScopes: readonly string[];
  }> = [];
  for (let leftIndex = 0; leftIndex < graph.implementationItems.length; leftIndex += 1) {
    const left = graph.implementationItems[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < graph.implementationItems.length; rightIndex += 1) {
      const right = graph.implementationItems[rightIndex]!;
      if (left.projectRepositoryId !== right.projectRepositoryId) continue;
      const leftOverlapping = left.changeScopes.filter((leftScope: string) =>
        right.changeScopes.some((rightScope: string) =>
          repositoryScopesOverlap(leftScope, rightScope)));
      if (leftOverlapping.length === 0) continue;
      if (dependsTransitivelyOn(left, right, graph.implementationItems)
        || dependsTransitivelyOn(right, left, graph.implementationItems)) continue;
      pairs.push({
        leftKey: left.key,
        rightKey: right.key,
        leftScopes: leftOverlapping,
        rightScopes: right.changeScopes.filter((rightScope: string) =>
          left.changeScopes.some((leftScope: string) =>
            repositoryScopesOverlap(leftScope, rightScope))),
      });
    }
  }
  return pairs;
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

/**
 * Render AC codes (AC-18) alongside raw artifact ids in coverage findings so
 * the repair worker reads the same identifiers the SRS/§D2 documents use.
 * Ids without a known code (foreign/invalid ids, exactly the ones a repair
 * targets) are simply absent from the legend; the raw id list stays complete.
 */
function acCodeLegend(
  developmentCase: DevelopmentCase,
  ids: readonly number[],
): string {
  const codes = ids
    .map(id => developmentCase.acceptanceCriteria.find(criterion =>
      acceptanceCriterionIdentity(criterion) === id))
    .filter((criterion): criterion is NonNullable<typeof criterion> =>
      criterion !== undefined && typeof criterion.code === 'string'
      && criterion.code.trim() !== '')
    .map(criterion => criterion.code);
  return codes.length === 0 ? '' : ` (codes: ${codes.join(', ')})`;
}

function invalidCase(developmentCase: DevelopmentCase): boolean {
  // 2026-08-22 Elite-4 planner dead-end: formalization may lawfully accept
  // ONE acceptance-contract artifact carrying MANY atomic criteria (codes
  // AC-1..N) — the baseline flattens them all to the same artifactId, and an
  // artifactId-only uniqueness demand rejected the PRODUCTION-built input on
  // every planner attempt (invalid-input-contract loop the model cannot
  // repair: the input is not its submission). Identity for the numeric
  // criterion matching stays artifactId; UNIQUENESS is the composite
  // (artifactId, code) — the same composite workspace-preparation already
  // keys verification targets by.
  const criterionKeys = developmentCase.acceptanceCriteria.map(
    criterion => `${criterion.artifactId}:${criterion.code ?? ''}`);
  return developmentCase.schemaVersion !== DEVELOPMENT_CASE_SCHEMA
    || developmentCase.projectId <= 0
    || developmentCase.epicId <= 0
    || !developmentCase.initiatedBy.trim()
    || developmentCase.formalizationCertificate.decision !== 'formalized'
    || !validRef(developmentCase.formalizationCertificate)
    || !validRef(developmentCase.solutionContract)
    || !developmentCase.acceptanceBaselineHash
    || !validRef(developmentCase.srs)
    || developmentCase.acceptanceCriteria.length === 0
    || !unique(criterionKeys)
    || developmentCase.acceptanceCriteria.some(criterion =>
      acceptanceCriterionIdentity(criterion) <= 0
      || criterion.artifactId <= 0
      || !criterion.acceptedHash.trim()
      || typeof criterion.implementationRequired !== 'boolean')
    || developmentCase.repositories.length === 0
    || !unique(developmentCase.repositories.map(repository =>
      repository.projectRepositoryId))
    || developmentCase.repositories.some(repository =>
      repository.projectRepositoryId <= 0
      || !repository.integrationBranch.trim()
      || !repository.expectedBaseCommit.trim())
    || !developmentCase.policy.id.trim()
    || !developmentCase.policy.version.trim()
    || !developmentCase.policy.contentHash.trim()
    || hashDevelopmentPolicy(developmentCase.policy)
      !== developmentCase.policy.contentHash;
}

function referenceMatches(
  reference: ContentAddressedReference | null,
  schema: string,
  hash: string,
): boolean {
  return reference !== null
    && reference.schema === schema
    && reference.hash === hash
    && reference.ref.trim().length > 0;
}

function result(
  decision: DevelopmentDecision,
  reasonCodes: readonly DevelopmentReasonCode[],
  rationale: string,
  inputHash: string,
  bundle: VerifiedIntegrationBundle | null = null,
): DevelopmentSettlementResult {
  return { decision, reasonCodes, rationale, inputHash, bundle };
}

/**
 * Authoritative settlement matrix for the Development module.
 */
export class ReferenceDevelopmentSettlementPolicy
implements DevelopmentSettlementPolicyPort {
  constructor(
    private readonly taskGraphPolicy: DevelopmentTaskGraphPolicyPort =
      new ReferenceDevelopmentTaskGraphPolicy(),
  ) {}

  settle(input: DevelopmentSettlementInput): DevelopmentSettlementResult {
    const inputHash = sha256Hex(input.developmentCase);

    if (
      input.schemaVersion !== DEVELOPMENT_SETTLEMENT_INPUT_SCHEMA
      || invalidCase(input.developmentCase)
    ) {
      return result(
        'failed',
        ['invalid-input-contract'],
        'Development settlement input or DevelopmentCase is invalid.',
        inputHash,
      );
    }

    if (input.taskGraph === null) {
      // 'clarification-required' was deleted: this state is unreachable through
      // normal production (the resolver materializes the graph before settle
      // runs); if it fires anyway the pipeline lied — failed, never rewritten.
      return result(
        'failed',
        ['task-graph-missing'],
        'No canonical task graph was materialized from the accepted SRS decomposition.',
        inputHash,
      );
    }
    const graphValidation = this.taskGraphPolicy.validate(
      input.developmentCase,
      input.taskGraph,
    );
    if (!graphValidation.valid) {
      // 'clarification-required' was deleted: a non-integrity rejection here
      // means the planner cell accepted a graph its own (stricter) check
      // would have rejected — an infrastructure lie, classified failed.
      return result(
        'failed',
        graphValidation.reasonCodes,
        graphValidation.errors.join('; '),
        inputHash,
      );
    }
    if (
      !referenceMatches(
        input.productReferences.taskGraph,
        DEVELOPMENT_TASK_GRAPH_SCHEMA,
        input.taskGraph.graphHash,
      )
    ) {
      return result(
        'failed',
        ['task-graph-lineage-mismatch'],
        'Task graph durable reference does not match the validated graph.',
        inputHash,
      );
    }

    const implementation = input.implementationWorkset;
    if (implementation === null) {
      return result(
        'blocked',
        ['implementation-workset-missing'],
        'Implementation/review workset has not been materialized.',
        inputHash,
      );
    }
    if (
      implementation.schemaVersion !== DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA
      || hashImplementationWorkset(implementation) !== implementation.worksetHash
      || !referenceMatches(
        input.productReferences.implementationWorkset,
        DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
        implementation.worksetHash,
      )
    ) {
      return result(
        'failed',
        ['implementation-workset-hash-invalid'],
        'Implementation workset integrity validation failed.',
        inputHash,
      );
    }
    if (implementation.taskGraphHash !== input.taskGraph.graphHash) {
      return result(
        'failed',
        ['task-graph-lineage-mismatch'],
        'Implementation workset targets a different task graph.',
        inputHash,
      );
    }

    const requiredImplementationKeys = new Set(
      input.taskGraph.implementationItems
        .filter(item => item.required)
        .map(item => item.key),
    );
    const declaredImplementationKeys = new Set(
      input.taskGraph.implementationItems.map(item => item.key),
    );
    const implementationByKey = new Map(
      implementation.results.map(item => [item.key, item]),
    );
    if (
      !unique(implementation.results.map(item => item.key))
      || implementation.results.some(item =>
        !declaredImplementationKeys.has(item.key)
        // taskId:0 is legal ONLY on the synthetic placeholder the workset
        // builder emits when no accepted product matched the item. That
        // placeholder is a settlement INPUT gap (implementation-incomplete),
        // not a malformed workset — see isMissingProductPlaceholder.
        || (item.taskId <= 0 && !isMissingProductPlaceholder(item))
        || !['succeeded', 'failed', 'blocked'].includes(item.status)
        || !unique(item.reasonCodes))
      || !unique(implementation.blockingItemKeys)
      || implementation.blockingItemKeys.some(key =>
        !declaredImplementationKeys.has(key))
    ) {
      return result(
        'failed',
        ['implementation-workset-hash-invalid'],
        'Implementation workset contains duplicate, undeclared or malformed results.',
        inputHash,
      );
    }
    // 'rework-required' [implementation-failed] was deleted: the integration
    // effect hard-requires terminalStatus='complete', so a failed workset item
    // cannot pass its own cell (W9-04-UNREACHABLE-EDGE-EVIDENCE, CLAIM 3).
    const blockedImplementation = [...requiredImplementationKeys].filter(key => {
      const item = implementationByKey.get(key);
      // The missing-product placeholder is NOT a worker "blocked" verdict:
      // route it to implementation-incomplete below so the verdict names the
      // real cause (an accepted cell product failed to bind to the item).
      return item?.status === 'blocked' && !isMissingProductPlaceholder(item);
    });
    if (blockedImplementation.length > 0) {
      return result(
        'blocked',
        ['implementation-blocked'],
        `Implementation/review is blocked for: ${blockedImplementation.join(', ')}.`,
        inputHash,
      );
    }
    const invalidSucceededImplementation = implementation.results.filter(item =>
      item.status === 'succeeded'
      && (
        !item.reviewedSourceCommit?.trim()
        || item.result === null
        || !validRef(item.result)
      ));
    if (invalidSucceededImplementation.length > 0) {
      return result(
        'failed',
        ['implementation-workset-hash-invalid'],
        `Succeeded implementation/review results lack exact commit or product evidence: ${invalidSucceededImplementation.map(item => item.key).join(', ')}.`,
        inputHash,
      );
    }
    const incompleteImplementation = [...requiredImplementationKeys].filter(key =>
      implementationByKey.get(key)?.status !== 'succeeded');
    // ADR-053: execution identities are provenance only. Completion below is
    // derived from exact accepted CandidateSet/revision products projected by
    // the durable authority head, never from author/reviewer execution ids.
    if (
      !implementation.complete
      || implementation.blockingItemKeys.length > 0
      || incompleteImplementation.length > 0
    ) {
      return result(
        'blocked',
        ['implementation-incomplete'],
        `Required implementation/review work is incomplete: ${incompleteImplementation.join(', ')}.`,
        inputHash,
      );
    }

    const candidate = input.integratedCandidate;
    if (candidate === null) {
      // X3 (SEAM L2): a FAILED local-readiness receipt explains WHY no runnable
      // candidate was ever bound. The settlement certificate is the durable
      // failure record the continuation/re-plan cycle reads — carrying the
      // decoded failure text (not only the binary) is the whole point.
      if (input.localReadinessReceipt?.outcome === 'failed') {
        return result(
          'blocked',
          ['candidate-missing', 'local-readiness-failed'],
          'No integrated release candidate was bound: local readiness FAILED '
          + `for the frozen candidate — ${describeLocalReadinessFailure(input.localReadinessReceipt)}`,
          inputHash,
        );
      }
      return result(
        'blocked',
        ['candidate-missing'],
        'No integrated release candidate was frozen.',
        inputHash,
      );
    }
    if (
      candidate.schemaVersion !== INTEGRATED_CANDIDATE_SCHEMA
      || hashIntegratedCandidate(candidate) !== candidate.candidateHash
      || !referenceMatches(
        input.productReferences.integratedCandidate,
        INTEGRATED_CANDIDATE_SCHEMA,
        candidate.candidateHash,
      )
    ) {
      return result(
        'failed',
        ['candidate-hash-invalid'],
        'Integrated candidate integrity validation failed.',
        inputHash,
      );
    }
    if (
      candidate.taskGraphHash !== input.taskGraph.graphHash
      || candidate.implementationWorksetHash !== implementation.worksetHash
    ) {
      return result(
        'failed',
        ['candidate-lineage-mismatch'],
        'Integrated candidate is not derived from the validated task graph and implementation workset.',
        inputHash,
      );
    }
    if (candidate.frozen !== true) {
      return result(
        'blocked',
        ['candidate-not-frozen'],
        'Candidate must be frozen before verification.',
        inputHash,
      );
    }
    if (input.observedCandidateHash !== candidate.candidateHash) {
      return result(
        'blocked',
        ['candidate-drifted-after-freeze'],
        'Repository/build state changed after candidate freeze; prior evidence is invalid.',
        inputHash,
      );
    }
    const expectedRepositoryIds = input.developmentCase.repositories.map(
      repository => repository.projectRepositoryId,
    );
    const repositoryById = new Map(
      input.developmentCase.repositories.map(repository => [
        repository.projectRepositoryId,
        repository,
      ]),
    );
    if (
      !unique(candidate.repositories.map(repository =>
        repository.projectRepositoryId))
      || !sameNumberSet(
        candidate.repositories.map(repository => repository.projectRepositoryId),
        expectedRepositoryIds,
      )
      || candidate.repositories.some(repository => {
        const expected = repositoryById.get(repository.projectRepositoryId);
        return expected === undefined
          || repository.branch !== expected.integrationBranch
          || !repository.commitSha.trim()
          || !repository.treeHash.trim();
      })
      || !unique(candidate.buildProducts.map(product =>
        `${product.kind}:${product.ref}`))
      || candidate.buildProducts.some(product =>
        !product.kind.trim()
        || !product.ref.trim()
        || !product.digest.trim())
      || !unique(candidate.integrationIntentRefs)
      || candidate.integrationIntentRefs.some(reference => !reference.trim())
      || (
        requiredImplementationKeys.size > 0
        && candidate.integrationIntentRefs.length === 0
      )
    ) {
      return result(
        'failed',
        ['candidate-lineage-mismatch'],
        'Candidate repositories, builds or integration intents do not match the DevelopmentCase scope.',
        inputHash,
      );
    }

    const verification = input.acceptanceVerification;
    if (verification === null) {
      return result(
        'blocked',
        ['verification-workset-missing'],
        'No verification workset exists for the frozen candidate.',
        inputHash,
      );
    }
    if (
      verification.schemaVersion !== ACCEPTANCE_VERIFICATION_SCHEMA
      || hashAcceptanceVerification(verification)
        !== verification.verificationHash
      || !referenceMatches(
        input.productReferences.acceptanceVerification,
        ACCEPTANCE_VERIFICATION_SCHEMA,
        verification.verificationHash,
      )
    ) {
      return result(
        'failed',
        ['verification-workset-hash-invalid'],
        'Verification workset integrity validation failed.',
        inputHash,
      );
    }
    if (
      verification.candidateHash !== candidate.candidateHash
      || verification.acceptanceBaselineHash
        !== input.developmentCase.acceptanceBaselineHash
    ) {
      return result(
        'failed',
        ['verification-lineage-mismatch'],
        'Verification does not target the exact frozen candidate and accepted baseline.',
        inputHash,
      );
    }

    const criterionById = new Map(
      input.developmentCase.acceptanceCriteria.map(criterion => [
        acceptanceCriterionIdentity(criterion),
        criterion,
      ]),
    );
    const requiredVerificationKeys = new Set(
      input.taskGraph.verificationItems
        .filter(item => item.required)
        .map(item => item.key),
    );
    const verificationItemByKey = new Map(
      input.taskGraph.verificationItems.map(item => [item.key, item]),
    );
    const evidenceByItem = new Map(
      verification.evidence.map(evidence => [
        evidence.verificationItemKey,
        evidence,
      ]),
    );
    if (
      !unique(verification.evidence.map(evidence =>
        evidence.verificationItemKey))
      || [...requiredVerificationKeys].some(key => !evidenceByItem.has(key))
      || verification.evidence.some(evidence =>
        !requiredVerificationKeys.has(evidence.verificationItemKey))
    ) {
      return result(
        'blocked',
        ['verification-evidence-missing'],
        'Verification evidence does not exactly cover the required verification workset.',
        inputHash,
      );
    }
    if (
      verification.evidence.some(evidence =>
        evidence.taskId <= 0
        || !validRef(evidence.evidence))
    ) {
      return result(
        'failed',
        ['verification-workset-hash-invalid'],
        'Verification workset contains malformed task or evidence references.',
        inputHash,
      );
    }

    for (const evidence of verification.evidence) {
      const criterion = criterionById.get(evidence.acceptanceCriterionId);
      const verificationItem = verificationItemByKey.get(
        evidence.verificationItemKey,
      );
      if (
        !criterion
        || !verificationItem
        || verificationItem.acceptanceCriterionIds[0]
          !== evidence.acceptanceCriterionId
        || evidence.acceptedCriterionHash !== criterion.acceptedHash
        || evidence.candidateHash !== candidate.candidateHash
      ) {
        return result(
          'failed',
          ['verification-lineage-mismatch'],
          `Verification evidence for item '${evidence.verificationItemKey}' has invalid lineage.`,
          inputHash,
        );
      }
      if (
        !evidence.provider.trusted
        || evidence.provider.category !== 'deterministic_evidence'
        || evidence.provider.providerId <= 0
        || !evidence.provider.name.trim()
      ) {
        return result(
          'blocked',
          ['verification-provider-untrusted'],
          `Verification provider for item '${evidence.verificationItemKey}' is not trusted deterministic evidence.`,
          inputHash,
        );
      }
      // 'rework-required' [verification-failed] was deleted: the settlement
      // evidence outcome comes from the trusted receipt reader, which admits
      // passed receipts only — a failed verdict terminalizes the verification
      // CELL instead (W9-04-UNREACHABLE-EDGE-EVIDENCE, CLAIM 3).
      if (evidence.outcome === 'unknown' || evidence.outcome === 'error') {
        return result(
          'blocked',
          ['verification-inconclusive'],
          `Acceptance verification is ${evidence.outcome} for AC ${evidence.acceptanceCriterionId}.`,
          inputHash,
        );
      }
    }
    if (!verification.complete) {
      return result(
        'blocked',
        ['verification-evidence-missing'],
        'Verification workset is not complete.',
        inputHash,
      );
    }
    // X3 (SEAM L2): failed AC verification is EVIDENCE, not silence. The
    // trusted receipt reader now admits failed receipts (they are the finding
    // record of the rejecting gate decision); settlement must name WHICH AC
    // failed (code + artifact id) with WHICH evidence ref — not collapse to a
    // generic verification-evidence-missing binary. The decision stays
    // blocked: a failed AC can never settle `verified`.
    const failedVerificationEvidence = verification.evidence.filter(
      evidence => evidence.outcome === 'failed',
    );
    if (failedVerificationEvidence.length > 0) {
      const failures = failedVerificationEvidence.map(evidence => {
        const criterion = criterionById.get(evidence.acceptanceCriterionId);
        const code = criterion
          && typeof criterion.code === 'string'
          && criterion.code.trim() !== ''
          ? criterion.code
          : `artifact-${evidence.acceptanceCriterionId}`;
        return `${code} (artifact ${evidence.acceptanceCriterionId}, item `
          + `'${evidence.verificationItemKey}') failed with evidence `
          + `${evidence.evidence.schema}:${evidence.evidence.ref}@${evidence.evidence.hash}`;
      }).join('; ');
      return result(
        'blocked',
        ['verification-failed'],
        `Acceptance verification FAILED for the frozen candidate: ${failures}.`,
        inputHash,
      );
    }
    if (input.openHumanGateIds.length > 0) {
      return result(
        'blocked',
        ['human-decision-required'],
        `Open human decisions: ${input.openHumanGateIds.join(', ')}.`,
        inputHash,
      );
    }

    // LR-07 / W5 — bind the terminal `verified` decision to the EXACT local-ready
    // proof. Local runnability is proven during development verification by the
    // local-runnability check provider and its receipt is durable (LR-06,
    // factory_check_receipts). Before LR-07 that receipt ran but was NOT bound to
    // settlement's terminal decision, so Development could be "verified" without a
    // proven-runnable-local product (W5). The terminal state now REQUIRES a
    // receipt that is (a) present, (b) outcome `passed`, and (c) bound to the
    // exact frozen integrated candidate — receipt.candidateHash ===
    // candidate.candidateHash. A missing or mismatched (different product's)
    // receipt keeps the terminal state closed: blocked / local-readiness-missing.
    // X3 (SEAM L2): a FAILED receipt bound to the EXACT candidate is a distinct,
    // evidence-carrying verdict — blocked / local-readiness-failed with the
    // decoded failure text, never the generic missing message.
    const readiness = input.localReadinessReceipt;
    if (
      readiness === null
      || readiness.candidateHash !== candidate.candidateHash
    ) {
      return result(
        'blocked',
        ['local-readiness-missing'],
        'No passed local-readiness receipt is bound to the exact frozen integrated candidate.',
        inputHash,
      );
    }
    if (readiness.outcome !== 'passed') {
      return result(
        'blocked',
        ['local-readiness-failed'],
        'Local readiness FAILED for the exact frozen integrated candidate '
        + `— ${describeLocalReadinessFailure(readiness)}`,
        inputHash,
      );
    }

    const taskGraphRef = input.productReferences.taskGraph;
    const implementationRef = input.productReferences.implementationWorkset;
    const candidateRef = input.productReferences.integratedCandidate;
    const verificationRef = input.productReferences.acceptanceVerification;
    if (
      taskGraphRef === null
      || implementationRef === null
      || candidateRef === null
      || verificationRef === null
    ) {
      return result(
        'failed',
        ['infrastructure-error'],
        'A validated Development product is missing its durable reference.',
        inputHash,
      );
    }

    const bundleBody: Omit<VerifiedIntegrationBundle, 'bundleHash'> = {
      schemaVersion: VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
      formalizationCertificate: input.developmentCase.formalizationCertificate,
      solutionContract: input.developmentCase.solutionContract,
      acceptanceBaselineHash: input.developmentCase.acceptanceBaselineHash,
      taskGraph: taskGraphRef,
      implementationWorkset: implementationRef,
      integratedCandidate: candidateRef,
      acceptanceVerification: verificationRef,
      repositories: [...candidate.repositories].sort((left, right) =>
        left.projectRepositoryId - right.projectRepositoryId),
      buildProducts: [...candidate.buildProducts].sort((left, right) =>
        `${left.kind}:${left.ref}`.localeCompare(`${right.kind}:${right.ref}`)),
    };
    const bundle: VerifiedIntegrationBundle = {
      ...bundleBody,
      bundleHash: sha256Hex(bundleBody),
    };

    return result(
      'verified',
      [],
      'Implementation, reviewed integration and acceptance evidence all bind to the unchanged frozen candidate.',
      inputHash,
      bundle,
    );
  }
}

/**
 * X3 (SEAM L2) — decode the failure text carried by a FAILED local-readiness
 * receipt. The receipt's evidenceRefs hold decodable factory-check-diagnostic
 * refs (the provider encodes the failing command output) and typed seam
 * repair-issue refs; both are human-readable once decoded. Pure: operates on
 * the immutable receipt only. Capped so a long history cannot bloat every
 * certificate.
 */
function describeLocalReadinessFailure(receipt: {
  outcome: 'passed' | 'failed';
  evidenceRefs: readonly string[];
}): string {
  const messages: string[] = [];
  for (const ref of receipt.evidenceRefs) {
    if (messages.length >= 3) break;
    const diagnostic = decodeCheckDiagnostic(ref);
    if (diagnostic !== null) {
      messages.push(`${diagnostic.code}: ${diagnostic.message}`.slice(0, 1200));
      continue;
    }
    // Seam repair-issue refs decode through their own prefix; surface the
    // readable body without importing the whole seam module (policy stays
    // dependency-light): the diagnostic branch covers the same failure text.
    if (ref.startsWith('factory-seam-repair-issue/v1/')) {
      try {
        const body = JSON.parse(
          Buffer.from(ref.split('/')[3] ?? '', 'base64url').toString('utf8'),
        ) as { seamKind?: unknown; producingTaskRef?: unknown; evidence?: { summary?: unknown } };
        const seam = typeof body.seamKind === 'string' ? body.seamKind : 'unknown';
        const owner = typeof body.producingTaskRef === 'string'
          ? body.producingTaskRef : 'unknown-owner';
        const summary = body.evidence && typeof body.evidence.summary === 'string'
          ? body.evidence.summary : '';
        messages.push(`seam ${seam} (producing ${owner}): ${summary}`.slice(0, 1200));
      } catch {
        // unreadable seam body — the diagnostic ref already carried the text
      }
    }
  }
  return messages.length > 0
    ? messages.join(' | ')
    : 'local runnability check failed (no decodable evidence in the receipt)';
}

export function buildDevelopmentCertificatePayload(
  settlement: DevelopmentSettlementResult,
  input: DevelopmentSettlementInput,
): DevelopmentCertificatePayload {
  return {
    schemaVersion: DEVELOPMENT_CERTIFICATE_SCHEMA,
    decision: settlement.decision,
    reasonCodes: settlement.reasonCodes,
    rationale: settlement.rationale,
    inputHash: settlement.inputHash,
    formalizationCertificateHash:
      input.developmentCase.formalizationCertificate.hash,
    solutionContractHash: input.developmentCase.solutionContract.hash,
    acceptanceBaselineHash: input.developmentCase.acceptanceBaselineHash,
    taskGraphHash: input.taskGraph?.graphHash ?? null,
    implementationWorksetHash:
      input.implementationWorkset?.worksetHash ?? null,
    candidateHash: input.integratedCandidate?.candidateHash ?? null,
    verificationHash: input.acceptanceVerification?.verificationHash ?? null,
    bundleHash: settlement.bundle?.bundleHash ?? null,
    policy: input.developmentCase.policy,
  };
}
