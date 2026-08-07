export const BUTTON_COLOR_WORKER_CONTRACTS = Object.freeze({
  'product-discovery/produce-proposal/author': {
    input: 'factory.discovery-case.v1', output: 'factory.discovery-proposal.v1', source: 'typed-submission',
  },
  'product-discovery/assess-readiness/author': {
    input: 'factory.discovery-proposal.v1', output: 'factory.discovery-readiness-assessment.v1', source: 'typed-submission',
  },
  'solution-formalization/define-product-contract/author': {
    output: 'factory.formalization-product-bundle.v1', source: 'managed-production', requiredArtifacts: ['brief', 'PRD', 'FR', 'RULE'],
  },
  'solution-formalization/model-use-cases/author': {
    output: 'factory.formalization-use-case-bundle.v1', source: 'managed-production', requiredArtifacts: ['UC'],
  },
  'solution-formalization/define-acceptance-contract/author': {
    output: 'factory.formalization-acceptance-bundle.v1', source: 'managed-production', requiredArtifacts: ['AC'],
  },
  'solution-formalization/reconcile-what/author': {
    output: 'factory.formalization-reconciliation-report.v1', source: 'typed-submission',
  },
  'solution-formalization/define-architecture-contract/author': {
    output: 'factory.formalization-architecture-bundle.v1', source: 'managed-production', requiredArtifacts: ['SRS'],
  },
  'solution-formalization/*/reviewer': {
    output: 'factory.review-verdict.v1', source: 'typed-submission',
  },
  'solution-development/plan-task-graph/author': {
    input: 'factory.development-case.v1', output: 'factory.development-task-graph-proposal.v1', source: 'typed-submission',
  },
  'solution-development/implement-work-items/author': {
    input: 'factory.development-task-graph.v1', output: 'factory.development-implementation-result.v1', source: 'typed-submission',
  },
  'solution-development/implement-work-items/reviewer': {
    output: 'factory.development-review-verdict.v1', source: 'typed-submission',
  },
  'solution-development/verify-acceptance/author': {
    input: 'factory.integrated-release-candidate.v1', output: 'factory.candidate-verification-evidence-product.v1', source: 'typed-submission',
  },
});

function moduleKind(moduleRef) {
  if (typeof moduleRef !== 'string') return 'unbound';
  return moduleRef.split('@')[0];
}

export function contractKey(ctx) {
  const role = ctx.role === 'reviewer' ? 'reviewer' : 'author';
  const exact = `${moduleKind(ctx.process_module_ref)}/${ctx.process_node_id}/${role}`;
  if (BUTTON_COLOR_WORKER_CONTRACTS[exact]) return exact;
  if (moduleKind(ctx.process_module_ref) === 'solution-formalization' && role === 'reviewer') {
    return 'solution-formalization/*/reviewer';
  }
  return exact;
}

export function workerContractFor(ctx) {
  return BUTTON_COLOR_WORKER_CONTRACTS[contractKey(ctx)] ?? null;
}

export function assertScenarioMatchesContract(ctx, scenario) {
  const contract = workerContractFor(ctx);
  if (!contract) {
    throw new Error(`SIMULATOR_CONTRACT_NOT_DECLARED: ${contractKey(ctx)}`);
  }
  const steps = scenario?.steps ?? [];
  if (contract.source === 'typed-submission') {
    const typed = steps.filter(step => step.type === 'product_submit');
    if (typed.length !== 1 || typed[0]?.args?.schema !== contract.output) {
      throw new Error(
        `SIMULATOR_OUTPUT_CONTRACT_MISMATCH: ${contractKey(ctx)} expected exactly one product_submit(${contract.output})`,
      );
    }
  } else if (contract.source === 'managed-production') {
    const artifactTypes = new Set(steps.filter(step => step.type === 'artifact_create').map(step => step.args?.type));
    for (const required of contract.requiredArtifacts ?? []) {
      if (!artifactTypes.has(required)) {
        throw new Error(`SIMULATOR_MANAGED_PRODUCT_INCOMPLETE: ${contractKey(ctx)} missing artifact type ${required}`);
      }
    }
  }
  if (!steps.some(step => step.type === 'worker_done')) {
    throw new Error(`SIMULATOR_WORKER_DONE_MISSING: ${contractKey(ctx)}`);
  }
  return contract;
}

export function assertStandardWorkerCoverage() {
  const expected = [
    'product-discovery/produce-proposal/author',
    'product-discovery/assess-readiness/author',
    'solution-formalization/define-product-contract/author',
    'solution-formalization/model-use-cases/author',
    'solution-formalization/define-acceptance-contract/author',
    'solution-formalization/reconcile-what/author',
    'solution-formalization/define-architecture-contract/author',
    'solution-formalization/*/reviewer',
    'solution-development/plan-task-graph/author',
    'solution-development/implement-work-items/author',
    'solution-development/implement-work-items/reviewer',
    'solution-development/verify-acceptance/author',
  ];
  for (const key of expected) {
    if (!BUTTON_COLOR_WORKER_CONTRACTS[key]) throw new Error(`SIMULATOR_STANDARD_WORKER_UNCOVERED: ${key}`);
  }
  return true;
}
