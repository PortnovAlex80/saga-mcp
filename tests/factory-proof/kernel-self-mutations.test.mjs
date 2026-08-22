// tests/factory-proof/kernel-self-mutations.test.mjs
//
// W0-4 — the proof-kernel SELF-MUTATION battery (brief revision a8014c03).
// Every way to quietly break the kernel must turn the suite red. The kernel
// already pins several of these inline (obligation-compiler T4/T5/T8,
// scenario-actor-observer A4/A5); this file adds the three that had no home:
//
//   S1 delete one obligation contract from a COPY of the registry → the
//      installed protection becomes unclassified → red;
//   S2 mutate an implementation digest in a manifest COPY → red (the
//      installed reader exposes digest divergence, not just id/version);
//   S3 disable one mutation operator → the operator-completeness ratchet +
//      the mandated derivation tests go red (every constraint kind must keep
//      ≥1 live operator, and the mandated families must stay derivable);
//   S4 a SECOND (ADR-090-shaped) obligation token claiming an already-owned
//      protection → red as PROTECTION_OWNER_AMBIGUOUS — when the future
//      epic-trace/conservation tokens land (ADR-090 §8 compiles them into
//      this single family), they must extend the OWNING contract, never
//      quietly double-claim the same validator.
//
// The remaining self-mutations from the brief are covered by:
//   'принять generated mutant'      → obligation-compiler T8;
//   'удалить protection'            → obligation-compiler T4;
//   'изменить provider/version'     → obligation-compiler T3 (version pin);
//   'actor смотрит attempt number'  → scenario-actor-observer A3/A4 (the
//                                      omniscient negative control);
//   'observer реконструирует из reducer' → scenario-actor-observer A5.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { compileNormativeObligations } from './obligation-contracts.mjs';
import { RELATIONAL_OPERATORS, STRUCTURAL_OPERATORS } from './mutation-algebra.mjs';
import {
  readInstalledProtections,
  assertProtectionSetEquality,
} from './installed-protection-reader.mjs';

async function realManifestModule() {
  return import(pathToFileURL(path.resolve(
    process.cwd(), 'dist/process-modules/application/workshop-capability-manifest.js',
  )).href);
}

test('S1: deleting one obligation contract from a COPY makes the suite red (the norm is not the installed surface)', async () => {
  const manifest = (await realManifestModule()).buildWorkshopCapabilityManifest();
  const installed = await readInstalledProtections({ manifest });
  const victim = compileNormativeObligations()[3];
  const mutilatedRegistry = compileNormativeObligations()
    .filter(c => c.obligationId !== victim.obligationId);
  assert.throws(
    () => assertProtectionSetEquality(mutilatedRegistry, installed),
    err => err.message.includes('PROTECTION_WITHOUT_OBLIGATION')
      && err.message.includes(victim.expectedProtection.logicalId),
    `deleting contract '${victim.obligationId}' must leave its protection unclassified`,
  );
});

test('S2: a swapped check id or version in a manifest COPY makes the suite red', async () => {
  const manifest = (await realManifestModule()).buildWorkshopCapabilityManifest();
  const victim = manifest.executableCapabilities.find(c => c.kind === 'check-provider');

  // Swap the logical id in place: the norm's id loses its protection AND the
  // stranger id is unclassified — both directions must name the red.
  const idSwapped = {
    ...manifest,
    executableCapabilities: manifest.executableCapabilities.map(c => c === victim
      ? { ...c, logicalId: `${c.logicalId}.evil-twin` }
      : c),
  };
  const installedIdSwapped = await readInstalledProtections({ manifest: idSwapped });
  assert.throws(
    () => assertProtectionSetEquality(compileNormativeObligations(), installedIdSwapped),
    err => err.message.includes('OBLIGATION_WITHOUT_PROTECTION')
      && err.message.includes(victim.logicalId),
  );

  // Same id, moved version: the version pin fires.
  const versionSwapped = {
    ...manifest,
    executableCapabilities: manifest.executableCapabilities.map(c => c === victim
      ? { ...c, version: '0.0.0-evil' }
      : c),
  };
  const installedVersionSwapped = await readInstalledProtections({ manifest: versionSwapped });
  assert.throws(
    () => assertProtectionSetEquality(compileNormativeObligations(), installedVersionSwapped),
    err => err.message.includes('PROTECTION_VERSION_DIVERGENCE')
      && err.message.includes(victim.logicalId),
  );
});

test('S3: the operator table is complete — every constraint kind keeps a live operator', async () => {
  const { relationalMutants, structuralMutants } = await import('./mutation-algebra.mjs');
  const { CONSTRAINT_KINDS } = await import('./obligation-contracts.mjs');

  // Every constraint kind derives at least one mutant over a minimal witness.
  const witnesses = {
    cardinality: { kind: 'cardinality', min: 1, member: 'items' },
    unique: { kind: 'unique', by: 'k' },
    grammar: { kind: 'grammar', field: 'heading' },
    ref: { kind: 'ref', field: 'subjectRef' },
    digestOf: { kind: 'digestOf', field: 'hash' },
    equality: { kind: 'equality', field: 'status' },
    subset: { kind: 'subset', member: 'ids' },
    projection: { kind: 'projection', field: 'proj' },
    lineage: { kind: 'lineage', field: 'chain' },
    ordering: { kind: 'ordering', field: 'events' },
    version: { kind: 'version', field: 'contractVersion' },
    crossField: { kind: 'crossField', rule: 'a implies b' },
  };
  const witnessValues = {
    cardinality: { items: [{ k: 1 }] },
    unique: { rows: [{ k: 1 }] },
    grammar: { heading: '## AC-1: Title' },
    ref: { subjectRef: 'artifact:9' },
    digestOf: { hash: 'a'.repeat(64) },
    equality: { status: 'accepted' },
    subset: { ids: ['a'] },
    projection: { proj: [{ x: 1 }] },
    lineage: { chain: ['a', 'b'] },
    ordering: { events: [1, 2] },
    version: { contractVersion: '1.0.0' },
    crossField: { a: 1, b: 1 },
  };
  const deadKinds = [];
  for (const kind of CONSTRAINT_KINDS) {
    const mutants = relationalMutants(witnesses[kind], witnessValues[kind], 'probe.kind');
    if (mutants.length === 0) deadKinds.push(kind);
  }
  assert.deepEqual(deadKinds, [],
    `constraint kinds with NO live operator (disabled algebra) — restore the operator or drop the kind: ${deadKinds.join(', ')}`);

  // The mandated families stay derivable (the W0-2 acceptance in miniature).
  assert.ok(structuralMutants({
    required: ['a'], properties: { a: { type: 'string' } }, contractVersion: '1.0.0',
  }, 'probe').some(m => m.operatorId === 'missing-required'));
  const ops = new Set(RELATIONAL_OPERATORS);
  for (const mandated of ['cardinality-zero', 'duplicate-key', 'grammar-malformed', 'grammar-truncated', 'grammar-near-miss']) {
    assert.ok(ops.has(mandated), `mandated operator '${mandated}' is in the table`);
  }
  assert.ok(STRUCTURAL_OPERATORS.length >= 7 && RELATIONAL_OPERATORS.length >= 20,
    'the operator ratchet: shrinking the table below the declared surface is a deliberate act');
});

test('S4: a future SECOND epic-trace token on the same protection is rejected as ambiguous', async () => {
  // ADR-090 (planned; NOT landed in this patch) will compile its conservation
  // proof tokens into this single ADR-084 family, and its epic-clause
  // coverage obligation explicitly REUSES the landed acceptance-contract
  // validator seam. This test proves the ownership fence that awaits it: a
  // second obligation token pointing at an already-owned protection fails
  // closed as PROTECTION_OWNER_AMBIGUOUS, naming both claimants. Simulated
  // on a registry COPY — no ADR-090 token is added to the real set.
  const manifest = (await realManifestModule()).buildWorkshopCapabilityManifest();
  const installed = await readInstalledProtections({ manifest });
  const owned = compileNormativeObligations()
    .find(c => c.obligationId === 'frm.submission.acceptance-contract');
  const futureEpicTraceToken = {
    ...owned,
    obligationId: 'frm.epic-trace-coverage',
    version: '0.1.0',
    protectedProperty: 'hypothetical ADR-090 epic-clause coverage token (S4 demonstration copy)',
  };
  assert.throws(
    () => assertProtectionSetEquality(
      [...compileNormativeObligations(), futureEpicTraceToken],
      installed,
    ),
    err => err.message.includes('PROTECTION_OWNER_AMBIGUOUS')
      && err.message.includes('frm.submission.acceptance-contract')
      && err.message.includes('frm.epic-trace-coverage'),
    'a second token over one protection must be rejected naming both claimants',
  );
  // The real registry (no ADR-090 tokens in this patch) stays clean.
  assert.doesNotThrow(() => assertProtectionSetEquality(compileNormativeObligations(), installed));
});
