/**
 * support.mjs - the FRF-WP09 Development handoff test support: composes
 * the FULL upstream authority chain from the committed fixtures -
 *   the WP03 green whole-WHAT baseline (independent evidence)
 *   -> the WP07 freeze desk (frozen baseline artifact)
 *   -> the WP08 architecture contract (authored over the same universe
 *      through the compiled WP08 desk - a REAL sealed contract, not a
 *      hand-forged shape)
 *   -> the WP07 settle desk (sealed solution contract)
 *   -> the WP09 case desk (DevelopmentCase)
 *   -> a green WorkItem set and a green plan.
 *
 * The green material is authored from the PLAN's desk contracts, never
 * derived from the WP09 validators under test.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

/** Import a local module by absolute path (file:// URL: Windows-safe). */
export const importAbs = (absolute) => import(pathToFileURL(absolute).href);

/* The package under test (src, test-only reachable). */
const HANDOFF = path.join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'development', 'handoff');
export const handoffModule = (name) => importAbs(path.join(HANDOFF, `${name}.mjs`));

/* The WP07 cell + its test support (frozen baseline + settlement). */
const WP07_TESTS = path.join(REPO_ROOT, 'tests', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze');
const wp07 = await importAbs(path.join(WP07_TESTS, 'support.mjs'));
export const wp07Settlement = () => importAbs(path.join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'settlement.mjs'));

export const {
  clone,
  freezeAccepted,
  greenBaselineFixture,
  lawfulHandoffOf,
  repositoryPolicyRefsOf,
  settleFrozen,
  srsAuthorityOf,
} = wp07;

/* The compiled WP08 cell (authors the architecture contract over the WP07 universe). */
const wp08Cell = await importAbs(path.join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'srs-realization', 'index.js'));

/* ------------------------------------------------------------------ */
/* The WP08 architecture contract over the WP07/WP03 fixture universe  */
/* ------------------------------------------------------------------ */

/**
 * The architecture-contract universe pinned to the FROZEN WP07 baseline:
 * the frozen scenario id set, the frozen evidence-binding ids, and the
 * baseline artifact digest + accepted SRS revision digest as pins.
 */
export function architectureUniverseOf(frozen, srs = srsAuthorityOf()) {
  return {
    idSets: {
      evidenceBindingIds: frozen.baseline.evidenceBindings.map((binding) => binding.evidenceBindingId),
      ucScenarioIds: frozen.baseline.containers.uc.members.map((member) => member.scenarioId),
    },
    revisionPins: {
      srsRevisionDigest: srs.revisionDigest,
      whatBaselineDigest: frozen.artifact.digest,
    },
  };
}

/** The green SRS scenario-realization draft over the WP07 universe (authored data). */
export function greenRealizationDraft() {
  return {
    lineage: { baselineRef: null, traceRule: 'srs-derived-from-frozen-what-baseline' }, // filled by authorArchitectureContractOver
    realizationEntries: [
      {
        compositionOwnerSurfaceRef: 'svc:cart-api',
        entrypointSurfaceRef: 'svc:cart-api',
        evidenceBinding: { evidenceBindingRef: 'ev:test-1', evidenceKind: 'test' },
        externalInterfaces: ['POST /cart/checkout'],
        implementationSurfaceRefs: ['module:audit-log'],
        participatingSurfaceRefs: ['svc:cart-api', 'module:audit-log'],
        realizationEntryId: 'realization:uc-checkout-1',
        runtimeEdges: [
          { fromSurfaceRef: 'svc:cart-api', toSurfaceRef: 'module:audit-log' },
          { fromSurfaceRef: 'module:audit-log', toSurfaceRef: 'terminal:checkout-rendered' },
        ],
        scenarioRef: 'uc:checkout-1',
        terminalResult: 'terminal:checkout-rendered',
      },
      {
        compositionOwnerSurfaceRef: 'svc:cart-api',
        entrypointSurfaceRef: 'svc:batch-runner',
        evidenceBinding: { evidenceBindingRef: 'ev:audit-1', evidenceKind: 'audit' },
        externalInterfaces: ['cron 0 * * * *'],
        implementationSurfaceRefs: ['module:audit-log'],
        participatingSurfaceRefs: ['svc:batch-runner', 'module:audit-log'],
        realizationEntryId: 'realization:uc-batch-1',
        runtimeEdges: [
          { fromSurfaceRef: 'svc:batch-runner', toSurfaceRef: 'module:audit-log' },
          { fromSurfaceRef: 'module:audit-log', toSurfaceRef: 'terminal:batch-receipt' },
        ],
        scenarioRef: 'uc:batch-1',
        terminalResult: 'terminal:batch-receipt',
      },
    ],
    schemaVersion: 'formalization.srs-realization.v1',
    surfaces: [
      { description: 'composition owner of the checkout and batch flows', realizedScenarioRefs: ['uc:checkout-1', 'uc:batch-1'], surfaceId: 'svc:cart-api', surfaceKind: 'composition' },
      { description: 'scheduled batch runner', realizedScenarioRefs: ['uc:batch-1'], surfaceId: 'svc:batch-runner', surfaceKind: 'infrastructure' },
      { description: 'shared audit log module', realizedScenarioRefs: ['uc:checkout-1', 'uc:batch-1'], surfaceId: 'module:audit-log', surfaceKind: 'infrastructure' },
    ],
  };
}

/** Author the sealed architecture contract over the frozen WP07 universe (the WP08 desk's green path). */
export function authorArchitectureContractOver(frozen, srs = srsAuthorityOf()) {
  const universe = architectureUniverseOf(frozen, srs);
  const draft = greenRealizationDraft();
  draft.lineage.baselineRef = `sha256:${universe.revisionPins.whatBaselineDigest}`;
  return wp08Cell.authorArchitectureContract(draft, universe);
}

/* ------------------------------------------------------------------ */
/* The full authority chain -> the DevelopmentCase                     */
/* ------------------------------------------------------------------ */

/** Freeze + author + settle the full authority chain over the WP03 green fixture. */
export async function sealedAuthorities(options = {}) {
  const frozen = options.frozen ?? await freezeAccepted();
  const srs = options.srs ?? srsAuthorityOf();
  const repositoryPolicyRefs = options.repositoryPolicyRefs ?? repositoryPolicyRefsOf();
  const assembly = options.architectureAssembly ?? authorArchitectureContractOver(frozen, srs);
  if (assembly.ok !== true) {
    throw new Error(`WP08 authoring failed over the WP07 universe: ${JSON.stringify(assembly)}`);
  }
  const settled = options.settled ?? await settleFrozen(frozen, { srs });
  if (settled.ok !== true || settled.outcome !== 'formalized') {
    throw new Error(`WP07 settlement failed: ${JSON.stringify(settled)}`);
  }
  return { architectureContract: assembly.product, frozen, repositoryPolicyRefs, settled, srs };
}

/** The case-desk authority inputs of the sealed chain. */
export function caseInputsOf(authorities) {
  return {
    architectureContract: authorities.architectureContract,
    baselineArtifact: authorities.frozen.artifact,
    frozenBaseline: authorities.frozen.baseline,
    repositoryPolicyRefs: authorities.repositoryPolicyRefs,
    solutionContract: authorities.settled.contract,
    srs: authorities.srs,
  };
}

/** Build the green DevelopmentCase from the sealed authorities. */
export async function buildGreenCase(options = {}) {
  const caseModule = await handoffModule('case');
  const authorities = await sealedAuthorities(options);
  const built = caseModule.buildDevelopmentCase(caseInputsOf(authorities));
  if (built.ok !== true) {
    throw new Error(`the green DevelopmentCase did not build: ${JSON.stringify(built)}`);
  }
  return { authorities, built, caseModule, developmentCase: built.developmentCase };
}

/* ------------------------------------------------------------------ */
/* The green WorkItem set and the green plan                           */
/* ------------------------------------------------------------------ */

/** The green WorkItem inputs covering the whole case lawfully. */
export function greenWorkItemInputs() {
  return [
    {
      acceptance: ['ac:checkout-end-1'],
      infrastructure: ['module:audit-log'],
      integration: ['svc:cart-api'],
      requirements: ['fr:cart-1'],
      scenarioRealization: [{ realizationEntryId: 'realization:uc-checkout-1', terminalResult: 'terminal:checkout-rendered' }],
      summary: 'realize the checkout scenario end to end',
      workItemId: 'wi:checkout',
    },
    {
      acceptance: ['ac:batch-error-1'],
      infrastructure: ['svc:batch-runner', 'module:audit-log'],
      integration: ['svc:cart-api'],
      requirements: ['fr:batch-1', 'nfr:retention-1', 'rule:audit-1'],
      scenarioRealization: [{ realizationEntryId: 'realization:uc-batch-1', terminalResult: 'terminal:batch-receipt' }],
      summary: 'realize the scheduled batch scenario with its audit terminal',
      workItemId: 'wi:batch',
    },
    {
      acceptance: ['ac:checkout-end-1', 'ac:batch-error-1'],
      summary: 'independent verifier over the frozen terminal evidence of both scenarios',
      verifier: [
        { evidenceBindingRef: 'ev:test-1', evidenceKind: 'test', realizationEntryId: 'realization:uc-checkout-1' },
        { evidenceBindingRef: 'ev:audit-1', evidenceKind: 'audit', realizationEntryId: 'realization:uc-batch-1' },
      ],
      workItemId: 'wi:verify',
    },
  ];
}

/** Build the green WorkItems (typed, digested). */
export async function buildGreenWorkItems(inputs = greenWorkItemInputs()) {
  const workitemModule = await handoffModule('workitem');
  return inputs.map((input) => {
    const built = workitemModule.buildWorkItem(input);
    if (built.ok !== true) {
      throw new Error(`the green WorkItem ${String(input.workItemId)} did not build: ${JSON.stringify(built)}`);
    }
    return built.workItem;
  });
}

/** Plan the green task graph over the green case. */
export async function planGreenCase(caseRecord, workItems) {
  const items = workItems ?? await buildGreenWorkItems();
  const planModule = await handoffModule('plan');
  const planned = planModule.planDevelopment(caseRecord.developmentCase, items);
  if (planned.ok !== true) {
    throw new Error(`the green plan did not pass the gates: ${JSON.stringify(planned)}`);
  }
  return planned;
}

/** Deep-clone helper for RED seeds (alias kept local). */
export const deepClone = (value) => structuredClone(value);
