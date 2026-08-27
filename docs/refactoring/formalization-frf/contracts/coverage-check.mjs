/**
 * FRF-WP03 vocabulary coverage check (deterministic, dual-mode).
 *
 * Cross-checks the five payload contracts against the DECLARED VOCABULARIES
 * of the frozen WP02 reverse graph
 * (docs/refactoring/formalization-frf/graphs/reverse/reverse-graph.json).
 *
 * Coverage law: every binding-kind vocabulary item the reverse graph
 * declares must be EXPRESSIBLE by the schema suite - verified by exact
 * set equality against a schema enum/keys, never by eyeball. Vocabulary
 * items that are not payload binding kinds (graph-model kinds, plan
 * validation predicates) receive an explicit recorded classification; an
 * item with neither an exact check nor a classification counts as
 * UNEXPRESSIBLE and fails the gate.
 *
 * Exit code 0 iff: zero unexpressible items, zero set-equality mismatches,
 * and the two AC citation shapes + the SRS realization binding surface are
 * all present.
 *
 * Usage:
 *   node docs/refactoring/formalization-frf/contracts/coverage-check.mjs
 *   node --test docs/refactoring/formalization-frf/contracts/coverage-check.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVERSE_GRAPH = path.resolve(HERE, '..', 'graphs', 'reverse', 'reverse-graph.json');

const load = (relative) => JSON.parse(readFileSync(path.join(HERE, relative), 'utf8'));
const schemas = {
  ac: load('schemas/ac-binding.schema.json'),
  baseline: load('schemas/what-baseline.schema.json'),
  prd: load('schemas/prd-intent-member.schema.json'),
  req: load('schemas/requirements-bundle.schema.json'),
  uc: load('schemas/uc-scenario-member.schema.json'),
};

const sortedJoin = (values) => [...values].sort().join('\u0000');
const sameSet = (a, b) => sortedJoin(a) === sortedJoin(b);

export function runCoverageCheck() {
  const failures = [];
  const rows = [];
  const fail = (detail) => failures.push(detail);
  const row = (item, status, where) => rows.push({ item, status, where });

  const reverse = JSON.parse(readFileSync(REVERSE_GRAPH, 'utf8'));
  if (reverse.artifact !== 'frf-reverse-graph' || reverse.version !== 1) {
    fail(`reverse graph identity: artifact=${String(reverse.artifact)} version=${String(reverse.version)}`);
  }
  const vocabularies = reverse.vocabularies ?? {};

  const checkExact = (name, expected, actual, where) => {
    if (sameSet(expected, actual)) {
      row(name, 'EXPRESSIBLE', where);
    } else {
      row(name, 'MISMATCH', where);
      fail(`${name}: schema carries [${[...actual].sort().join(', ')}], reverse graph declares [${[...expected].sort().join(', ')}] (${where})`);
    }
  };

  /* 1. actorKinds (5) - UC scenario member actor vocabulary. */
  if (!Array.isArray(vocabularies.actorKinds?.values)) fail('reverse graph: actorKinds.values missing');
  else {
    checkExact(
      'actorKinds',
      vocabularies.actorKinds.values,
      schemas.uc.properties.actorKind.enum,
      'uc-scenario-member.schema.json properties.actorKind.enum',
    );
  }

  /* 2. evidenceKinds (4) - UC evidence refs, AC evidence, baseline evidence bindings. */
  if (!Array.isArray(vocabularies.evidenceKinds?.values)) fail('reverse graph: evidenceKinds.values missing');
  else {
    for (const [enumNode, where] of [
      [schemas.uc.properties.evidenceKindRefs.items.enum, 'uc-scenario-member.schema.json properties.evidenceKindRefs.items.enum'],
      [schemas.ac.properties.evidence.properties.evidenceKind.enum, 'ac-binding.schema.json properties.evidence.evidenceKind.enum'],
      [schemas.baseline.$defs.evidenceBindingRecord.properties.evidenceKind.enum, 'what-baseline.schema.json $defs.evidenceBindingRecord.evidenceKind.enum'],
    ]) {
      checkExact('evidenceKinds', vocabularies.evidenceKinds.values, enumNode, where);
    }
  }

  /* 3. intentDispositions (4) - PRD intent member disposition vocabulary. */
  if (vocabularies.intentDispositions?.values === undefined) fail('reverse graph: intentDispositions.values missing');
  else {
    checkExact(
      'intentDispositions',
      Object.keys(vocabularies.intentDispositions.values),
      schemas.prd.properties.disposition.properties.disposition.enum,
      'prd-intent-member.schema.json properties.disposition.disposition.enum',
    );
  }

  /* 4. handoffBindingKinds (12) - baseline development surface manifest. */
  if (vocabularies.handoffBindingKinds?.values === undefined) fail('reverse graph: handoffBindingKinds.values missing');
  else {
    const declared = Object.keys(vocabularies.handoffBindingKinds.values);
    const manifest = schemas.baseline.properties.developmentSurface.properties.handoffBindingKinds;
    checkExact(
      'handoffBindingKinds',
      declared,
      Object.keys(manifest.properties),
      'what-baseline.schema.json properties.developmentSurface.handoffBindingKinds (properties)',
    );
    checkExact(
      'handoffBindingKinds (required)',
      declared,
      manifest.required,
      'what-baseline.schema.json properties.developmentSurface.handoffBindingKinds (required)',
    );
  }

  /* 5. workItemObligationKinds (5) - baseline development surface manifest. */
  if (vocabularies.workItemObligationKinds?.values === undefined) fail('reverse graph: workItemObligationKinds.values missing');
  else {
    const declared = Object.keys(vocabularies.workItemObligationKinds.values);
    const manifest = schemas.baseline.properties.developmentSurface.properties.workItemObligationKinds;
    checkExact(
      'workItemObligationKinds',
      declared,
      Object.keys(manifest.properties),
      'what-baseline.schema.json properties.developmentSurface.workItemObligationKinds (properties)',
    );
    checkExact(
      'workItemObligationKinds (required)',
      declared,
      manifest.required,
      'what-baseline.schema.json properties.developmentSurface.workItemObligationKinds (required)',
    );
  }

  /* 6. traceGrammarRules (8) - baseline frozen trace set grammar. */
  if (vocabularies.traceGrammarRules === undefined) fail('reverse graph: traceGrammarRules missing');
  else {
    checkExact(
      'traceGrammarRules',
      Object.keys(vocabularies.traceGrammarRules),
      schemas.baseline.$defs.traceRecord.properties.kind.enum,
      'what-baseline.schema.json $defs.traceRecord.kind.enum',
    );
  }

  /* 7. The AC -> UC/branch citation shapes (both required by the reverse grammar, edges 0051+0052). */
  const bindsTo = schemas.ac.properties.bindsTo.properties;
  for (const shape of ['ucScenarioRefs', 'ucTerminalBranchRefs']) {
    if (bindsTo[shape] === undefined) {
      row(`ac-citation:${shape}`, 'UNEXPRESSIBLE', 'ac-binding.schema.json bindsTo');
      fail(`ac-binding schema cannot express the ${shape} citation shape`);
    } else {
      row(`ac-citation:${shape}`, 'EXPRESSIBLE', `ac-binding.schema.json properties.bindsTo.${shape}`);
    }
  }
  const requirementDerivation = schemas.req.$defs.requirementMember.properties.derivation.properties;
  for (const shape of ['ucScenarioRefs', 'ucTerminalBranchRefs']) {
    if (requirementDerivation[shape] === undefined) {
      row(`fr-citation:${shape}`, 'UNEXPRESSIBLE', 'requirements-bundle.schema.json derivation');
      fail(`requirements-bundle schema cannot express the ${shape} lineage shape`);
    } else {
      row(`fr-citation:${shape}`, 'EXPRESSIBLE', `requirements-bundle.schema.json $defs.requirementMember.derivation.${shape}`);
    }
  }

  /* 8. SRS realization bindings - a declared handoff kind resolving against the named post-freeze SRS surface. */
  {
    const manifest = schemas.baseline.properties.developmentSurface.properties.handoffBindingKinds;
    const surfaces = manifest.properties['scenario-realization-bindings'];
    if (surfaces === undefined) {
      row('srs-realization-bindings', 'UNEXPRESSIBLE', 'what-baseline.schema.json developmentSurface');
      fail('scenario-realization-bindings is not a declared handoff binding kind');
    } else if (!surfaces.$ref || !schemas.baseline.$defs.handoffSurfaceEntry) {
      row('srs-realization-bindings', 'MISMATCH', 'what-baseline.schema.json developmentSurface');
      fail('scenario-realization-bindings does not reference the handoffSurfaceEntry contract');
    } else {
      const allowed = schemas.baseline.$defs.handoffSurfaceEntry.properties.resolvesAgainst.items.enum;
      if (!allowed.includes('postFreeze.srs.realizationEntryIds')) {
        row('srs-realization-bindings', 'UNEXPRESSIBLE', 'what-baseline.schema.json handoffSurfaceEntry');
        fail('the resolution-surface vocabulary cannot name the post-freeze SRS realization entries');
      } else {
        row('srs-realization-bindings', 'EXPRESSIBLE', 'what-baseline.schema.json developmentSurface.handoffBindingKinds[scenario-realization-bindings] -> postFreeze.srs.realizationEntryIds');
      }
    }
  }

  /* 9. Baseline-internal resolution surfaces actually exist in the schema structure. */
  {
    const surfacePaths = {
      'caseIdentity.discoveryCertificateRef': schemas.baseline.properties.caseIdentity.properties.discoveryCertificateRef,
      'caseIdentity.formalizationCaseRef': schemas.baseline.properties.caseIdentity.properties.formalizationCaseRef,
      'containers.ac.criterionIds': schemas.baseline.properties.containers.properties.ac,
      'containers.fr.memberIds': schemas.baseline.properties.containers.properties.fr,
      'containers.nfr.memberIds': schemas.baseline.properties.containers.properties.nfr,
      'containers.prd.memberIds': schemas.baseline.properties.containers.properties.prd,
      'containers.rule.memberIds': schemas.baseline.properties.containers.properties.rule,
      'containers.uc.scenarioIds': schemas.baseline.properties.containers.properties.uc,
      'sourceManifests.claimIds': schemas.baseline.properties.sourceManifests.properties.claims,
      'sourceManifests.constraintIds': schemas.baseline.properties.sourceManifests.properties.constraints,
      'sourceManifests.terminalClaimIds': schemas.baseline.properties.sourceManifests.properties.terminalClaims,
      'wholeWhatDigest': schemas.baseline.properties.wholeWhatDigest,
    };
    for (const [surface, node] of Object.entries(surfacePaths)) {
      if (node === undefined) {
        row(`surface:${surface}`, 'UNEXPRESSIBLE', 'what-baseline.schema.json');
        fail(`resolution surface ${surface} does not exist in the baseline schema`);
      } else {
        row(`surface:${surface}`, 'EXPRESSIBLE', 'what-baseline.schema.json');
      }
    }
    for (const surface of schemas.baseline.$defs.handoffSurfaceEntry.properties.resolvesAgainst.items.enum) {
      if (!surface.startsWith('postFreeze.') && surfacePaths[surface] === undefined) {
        fail(`resolution surface ${surface} is neither baseline-internal nor a declared post-freeze authority`);
      }
    }
  }

  /* 10. planInvalidOmissions (5) - plan-validation predicates; the suite carries
   *     their resolution surfaces (obligation kinds + evidence kinds); the
   *     predicate checks themselves belong to the WP08 SRS validator and the
   *     WP09 plan validator that consume these surfaces. Recorded classification. */
  if (!Array.isArray(vocabularies.planInvalidOmissions?.values)) fail('reverse graph: planInvalidOmissions.values missing');
  else {
    const obligationManifest = schemas.baseline.properties.developmentSurface.properties.workItemObligationKinds.properties;
    for (const omission of vocabularies.planInvalidOmissions.values) {
      const carriers = {
        'composition-owner': 'integration-or-composition-obligation',
        'runtime-edge': 'integration-or-composition-obligation',
        'scenario-entrypoint': 'scenario-realization-obligation',
        'terminal-result': 'scenario-realization-obligation',
        'verifier': 'evidenceKinds (independent-agent-review) + verifier-obligation (reverse material/verifier-obligation)',
      }[omission];
      if (carriers === undefined) {
        row(`planInvalidOmission:${omission}`, 'UNEXPRESSIBLE', '-');
        fail(`plan invalid omission "${omission}" has no carrier in the schema suite`);
      } else if (carriers.startsWith('evidenceKinds')) {
        row(`planInvalidOmission:${omission}`, 'CLASSIFIED', `${carriers}; the verifier predicate is enforced by WP09 plan validation over the frozen surfaces`);
      } else if (obligationManifest[carriers] !== undefined) {
        row(`planInvalidOmission:${omission}`, 'CLASSIFIED', `carried by workItemObligationKinds["${carriers}"]; the predicate is enforced by the WP08/WP09 validators consuming this frozen surface`);
      } else {
        row(`planInvalidOmission:${omission}`, 'UNEXPRESSIBLE', carriers);
        fail(`plan invalid omission "${omission}" names carrier ${carriers} which is not declared`);
      }
    }
  }

  /* 11. nodeKinds (30) - the reverse graph's own graph-model vocabulary, not a
   *     payload binding vocabulary. Payload-bearing kinds map to their schema;
   *     the rest are recorded with their owning package. Recorded classification. */
  if (vocabularies.nodeKinds === undefined) fail('reverse graph: nodeKinds missing');
  else {
    const payloadSchemaByKind = {
      'acceptance-contract': 'what-baseline (containers.ac)',
      'acceptance-criterion': 'ac-binding',
      'architecture-contract': 'WP08 (SRS scenario realization; consumes the frozen baseline)',
      'case-identity': 'what-baseline (caseIdentity)',
      'composition-obligation': 'what-baseline (developmentSurface.workItemObligationKinds)',
      'construction-obligation': 'what-baseline (developmentSurface.workItemObligationKinds)',
      'development-input': 'WP09 (DevelopmentCase; resolves against the frozen developmentSurface)',
      'development-plan': 'WP09 (plan validation predicates)',
      'development-plan-unit': 'WP09 (WorkItem obligation bindings)',
      'disposition-record': 'what-baseline (dispositions) + prd-intent-member (disposition)',
      'evidence-record': 'what-baseline (evidenceBindings)',
      'freeze-authority': 'what-baseline',
      'functional-requirement': 'requirements-bundle (FR)',
      'gate-decision-record': 'kernel (GateDecision; not a payload contract)',
      'intent-member': 'prd-intent-member',
      'kernel-acceptance-record': 'what-baseline (acceptanceRecords)',
      'policy-binding': 'what-baseline (developmentSurface handoff kind repository-and-policy-bindings)',
      'product-brief': 'kernel accepted-material seed (briefRefs id set)',
      'product-contract': 'what-baseline (containers.prd)',
      'product-terminal-claim': 'prd-intent-member (terminalClaimRefs) + what-baseline (sourceManifests.terminalClaims)',
      'quality-requirement': 'requirements-bundle (NFR)',
      'realization-entry': 'WP08 (SRS scenario realization; surface frozen as postFreeze.srs.realizationEntryIds)',
      'scenario': 'uc-scenario-member',
      'scenario-branch': 'uc-scenario-member (terminalBranches)',
      'scenario-container': 'what-baseline (containers.uc)',
      'settlement-output': 'WP07 (solution contract; surface frozen as postFreeze.settlement.solutionContractDigest)',
      'settlement-trace-set': 'what-baseline (traceSet)',
      'source-claim': 'prd-intent-member (sourceClaimRefs) + what-baseline (sourceManifests)',
      'system-rule': 'requirements-bundle (RULE)',
      'terminal-claim': 'reverse graph claim nodes (assertions, not payload)',
      'verifier-obligation': 'WP09 (verifier predicate over frozen surfaces)',
    };
    for (const kind of Object.keys(vocabularies.nodeKinds)) {
      const carrier = payloadSchemaByKind[kind];
      if (carrier === undefined) {
        row(`nodeKind:${kind}`, 'UNEXPRESSIBLE', '-');
        fail(`reverse node kind "${kind}" has no recorded carrier`);
      } else {
        row(`nodeKind:${kind}`, carrier.startsWith('WP') || carrier.startsWith('kernel') ? 'CLASSIFIED' : 'EXPRESSIBLE', carrier);
      }
    }
  }

  const unexpressible = rows.filter((entry) => entry.status === 'UNEXPRESSIBLE').length;
  const mismatches = rows.filter((entry) => entry.status === 'MISMATCH').length;
  return { rows, unexpressible, mismatches, failures, vocabularies: Object.keys(vocabularies).sort() };
}

/* ---------- dual-mode entry ---------- */

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const report = (result) => {
  const byStatus = {};
  for (const entry of result.rows) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
  console.log('frf-wp03 vocabulary coverage: reverse-graph vocabularies checked:');
  for (const name of result.vocabularies) console.log(`  - ${name}`);
  console.log(`  items: ${result.rows.length} total, ${byStatus.EXPRESSIBLE ?? 0} expressible (exact), ${byStatus.CLASSIFIED ?? 0} classified (recorded), ${result.unexpressible} UNEXPRESSIBLE, ${result.mismatches} mismatched`);
};

test('frf-wp03 vocabulary coverage: zero unexpressible items', () => {
  const result = runCoverageCheck();
  report(result);
  if (result.failures.length > 0) {
    throw new Error(`${result.failures.length} coverage failure(s):\n` + result.failures.map((f) => `  ${f}`).join('\n'));
  }
});

if (isDirectRun) {
  const result = runCoverageCheck();
  if (result.failures.length === 0 && result.unexpressible === 0 && result.mismatches === 0) {
    report(result);
    console.log('frf-wp03 vocabulary coverage: CLEAN (zero unexpressible items)');
  } else {
    report(result);
    console.error(`frf-wp03 vocabulary coverage: RED (${result.failures.length} failure(s), ${result.unexpressible} unexpressible, ${result.mismatches} mismatched)`);
    for (const failure of result.failures) console.error(`  ${failure}`);
    process.exitCode = 1;
  }
}
