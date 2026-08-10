/**
 * Deterministic validation and settlement policies for Development.
 *
 * These policies do no I/O and contain no LM decisions. Installation adapters
 * materialize the task graph/worksets/candidate/evidence; the policies only
 * validate immutable snapshots and derive the local process outcome.
 */

import { sha256Hex } from '../../../shared/canonical-json.js';
import {
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
  return hashWithoutField(workset, 'worksetHash');
}

export function hashIntegratedCandidate(
  candidate: IntegratedReleaseCandidate,
): string {
  return hashWithoutField(candidate, 'candidateHash');
}

export function hashAcceptanceVerification(
  verification: AcceptanceVerificationWorkset,
): string {
  return hashWithoutField(verification, 'verificationHash');
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
        || item.changeScopes.some(scope => !scope.trim()))
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

    for (let leftIndex = 0; leftIndex < graph.implementationItems.length; leftIndex += 1) {
      const left = graph.implementationItems[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < graph.implementationItems.length; rightIndex += 1) {
        const right = graph.implementationItems[rightIndex]!;
        if (
          left.projectRepositoryId !== right.projectRepositoryId
          || !left.changeScopes.some(scope => right.changeScopes.includes(scope))
        ) continue;
        if (!dependsTransitivelyOn(left, right, graph.implementationItems)
          && !dependsTransitivelyOn(right, left, graph.implementationItems)) {
          pushIssue(
            reasonCodes,
            errors,
            'implementation-scope-overlap',
            `implementation items '${left.key}' and '${right.key}' overlap without a dependency order`,
          );
        }
      }
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
      developmentCase.acceptanceCriteria.map(criterion => criterion.artifactId),
    );
    const implementationRequired = new Set(
      developmentCase.acceptanceCriteria
        .filter(criterion => criterion.implementationRequired)
        .map(criterion => criterion.artifactId),
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
      pushIssue(
        reasonCodes,
        errors,
        'implementation-coverage-gap',
        'required implementation coverage does not equal the accepted AC scope',
      );
    }
    if (
      [...verificationCovered].some(id => !acceptedCriterionIds.has(id))
      || !sameNumberSet(verificationCovered, acceptedCriterionIds)
    ) {
      pushIssue(
        reasonCodes,
        errors,
        'verification-plan-coverage-gap',
        'the task graph must contain verification work for every accepted AC',
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

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function invalidCase(developmentCase: DevelopmentCase): boolean {
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
    || !unique(developmentCase.acceptanceCriteria.map(criterion =>
      criterion.artifactId))
    || developmentCase.acceptanceCriteria.some(criterion =>
      criterion.artifactId <= 0
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
      return result(
        'clarification-required',
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
      const integrityFailure = graphValidation.reasonCodes.some(code =>
        code === 'task-graph-hash-invalid'
        || code === 'task-graph-lineage-mismatch');
      return result(
        integrityFailure ? 'failed' : 'clarification-required',
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
        || item.taskId <= 0
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
    const failedImplementation = [...requiredImplementationKeys].filter(key =>
      implementationByKey.get(key)?.status === 'failed');
    if (failedImplementation.length > 0) {
      return result(
        'rework-required',
        ['implementation-failed'],
        `Implementation/review failed for: ${failedImplementation.join(', ')}.`,
        inputHash,
      );
    }
    const blockedImplementation = [...requiredImplementationKeys].filter(key =>
      implementationByKey.get(key)?.status === 'blocked');
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
        !item.implementationExecutionId?.trim()
        || !item.reviewExecutionId?.trim()
        || !item.reviewedSourceCommit?.trim()
        || item.result === null
        || !validRef(item.result)
      ));
    if (invalidSucceededImplementation.length > 0) {
      return result(
        'failed',
        ['implementation-workset-hash-invalid'],
        `Succeeded implementation/review results lack execution, review, commit or product evidence: ${invalidSucceededImplementation.map(item => item.key).join(', ')}.`,
        inputHash,
      );
    }
    const incompleteImplementation = [...requiredImplementationKeys].filter(key =>
      implementationByKey.get(key)?.status !== 'succeeded');
    if (
      !implementation.complete
      || implementation.blockingItemKeys.length > 0
      || incompleteImplementation.length > 0
    ) {
      return result(
        'blocked',
        ['implementation-incomplete'],
        'Required implementation/review work is incomplete.',
        inputHash,
      );
    }

    const candidate = input.integratedCandidate;
    if (candidate === null) {
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
        criterion.artifactId,
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
      if (evidence.outcome === 'failed') {
        return result(
          'rework-required',
          ['verification-failed'],
          `Acceptance verification failed for AC ${evidence.acceptanceCriterionId}.`,
          inputHash,
        );
      }
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
    if (input.openHumanGateIds.length > 0) {
      return result(
        'blocked',
        ['human-decision-required'],
        `Open human decisions: ${input.openHumanGateIds.join(', ')}.`,
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
