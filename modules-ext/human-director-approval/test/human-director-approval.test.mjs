// @ts-check
/**
 * W10-A3 — Human Director Approval package test.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`
 *       (lane W10-A3: arbitrary Human-node extensibility proof).
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a3.md`.
 *
 * Loads the package TypeScript source directly (Node >= 22.6 type-stripping),
 * then asserts:
 *   1. The `ProcessModuleManifest` is valid (validateProcessModuleManifest
 *      returns ok). The manifest throws synchronously at module load if not, so
 *      merely importing it is the first gate.
 *   2. The director-signoff `NodeProtocolDefinition` is valid
 *      (validateNodeProtocolDefinition returns ok).
 *   3. The definition has the documented Human-node shape: one `human` node with
 *      an `interactionContract`, exactly two terminal outcomes.
 *   4. Every pinned resource in the resource index resolves to a real file
 *      UNDER the package root (no traversal, no global lookup).
 *   5. The import boundary (WAVE10-EXTENSIBILITY-SPEC §4) holds: the package's
 *      own source imports ONLY from the pure SPI surface, never from
 *      `src/index.ts`, `modules/catalog.ts`, the composition root, or any
 *      existing module. This IS the §0.13.10 extensibility proof.
 *
 * Run: `node --test modules-ext/human-director-approval/test/human-director-approval.test.mjs`
 * (after `npm run build` emits `dist/`).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Node >= 22.6 type-strips .ts on import. The package source imports the SPI
// validators from the root-compiled dist/ (emitted by `npm run build`).
import {
  DIRECTOR_CONSOLE_ADAPTER_REF,
  DIRECTOR_SIGNOFF_NODE_PROTOCOL,
  DIRECTOR_SIGNOFF_NODE_RESOURCES,
  HUMAN_DIRECTOR_ADAPTER_REFS,
  HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
  HUMAN_DIRECTOR_HANDLER_REFS,
  HUMAN_DIRECTOR_INPUT_CONTRACT_REF,
  HUMAN_DIRECTOR_INPUT_SCHEMA,
  HUMAN_DIRECTOR_INTERACTION_CONTRACT,
  HUMAN_DIRECTOR_MANIFEST_FORMAT_VERSION,
  HUMAN_DIRECTOR_MODULE_KEY,
  HUMAN_DIRECTOR_OUTPUT_CONTRACT_REF,
  HUMAN_DIRECTOR_OUTPUT_SCHEMA,
  HUMAN_DIRECTOR_RESOURCE_INDEX,
  humanDirectorApprovalManifest,
  humanDirectorApprovalModule,
  validateDirectorSignoffNodeProtocol,
} from '../src/index.ts';
import {
  validateNodeProtocolDefinition,
} from '../src/node-protocols/director-signoff-node-protocol.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

// ---------------------------------------------------------------------------
// 1. Manifest validity (the module-load throw is the first gate; here we also
//    re-run the validator explicitly to surface a clean failure list).
// ---------------------------------------------------------------------------

test('W10-A3: manifest loads (synchronous validation at module load did not throw)', () => {
  assert.ok(humanDirectorApprovalManifest, 'manifest imported without throwing');
});

test('W10-A3: manifest has the documented identity and format version', () => {
  assert.equal(
    humanDirectorApprovalManifest.manifestFormatVersion,
    HUMAN_DIRECTOR_MANIFEST_FORMAT_VERSION,
    'manifestFormatVersion',
  );
  assert.equal(HUMAN_DIRECTOR_MANIFEST_FORMAT_VERSION, '1', 'format version is the real-package signal');
  const def = humanDirectorApprovalManifest.definition;
  assert.equal(def.identity.name, 'human-director-approval', 'identity.name');
  assert.equal(def.identity.version, '1.0.0', 'identity.version');
  assert.equal(def.identity.kind, 'human-approval', 'identity.kind');
  assert.equal(
    HUMAN_DIRECTOR_APPROVAL_MODULE_REF.name,
    'human-director-approval',
    'module ref name',
  );
  assert.equal(HUMAN_DIRECTOR_MODULE_KEY, 'human-director-approval@1.0.0', 'module key');
});

test('W10-A3: manifest contract refs match the definition contract ids', () => {
  assert.equal(
    humanDirectorApprovalManifest.inputContractRef.schemaId,
    HUMAN_DIRECTOR_INPUT_SCHEMA,
    'inputContractRef.schemaId matches inputContract.id',
  );
  assert.equal(
    humanDirectorApprovalManifest.outputContractRef.schemaId,
    HUMAN_DIRECTOR_OUTPUT_SCHEMA,
    'outputContractRef.schemaId matches outputContract.id',
  );
  assert.equal(
    HUMAN_DIRECTOR_INPUT_CONTRACT_REF.schemaId,
    humanDirectorApprovalManifest.definition.inputContract.id,
  );
  assert.equal(
    HUMAN_DIRECTOR_OUTPUT_CONTRACT_REF.schemaId,
    humanDirectorApprovalManifest.definition.outputContract.id,
  );
  // digests are the documented Wave-2 placeholder until codecs land.
  assert.equal(humanDirectorApprovalManifest.inputContractRef.digest, 'pending@wave-2');
  assert.equal(humanDirectorApprovalManifest.outputContractRef.digest, 'pending@wave-2');
});

test('W10-A3: manifest runtimeCompatibilityRange is the saga 3.x range', () => {
  assert.equal(
    humanDirectorApprovalManifest.runtimeCompatibilityRange,
    '^3.0.0',
    'runtimeCompatibilityRange',
  );
});

// ---------------------------------------------------------------------------
// 2. NodeProtocol validity.
// ---------------------------------------------------------------------------

test('W10-A3: director-signoff NodeProtocol is valid', () => {
  const result = validateDirectorSignoffNodeProtocol();
  assert.equal(result.ok, true, `NodeProtocol must be valid: ${JSON.stringify(result.errors)}`);
});

test('W10-A3: director-signoff NodeProtocol owns the director-signoff flow node', () => {
  assert.equal(DIRECTOR_SIGNOFF_NODE_PROTOCOL.owningFlowNodeId, 'director-signoff');
  assert.equal(
    DIRECTOR_SIGNOFF_NODE_PROTOCOL.retrySemantics,
    'runtime-implemented-linear',
    'retrySemantics is a supported kind (not "unsupported")',
  );
  // entry step must resolve against the step list.
  const stepIds = DIRECTOR_SIGNOFF_NODE_PROTOCOL.steps.map((s) => s.id);
  assert.ok(stepIds.includes(DIRECTOR_SIGNOFF_NODE_PROTOCOL.entryStep), 'entryStep resolves');
  // every transition references existing steps.
  for (const t of DIRECTOR_SIGNOFF_NODE_PROTOCOL.transitions) {
    assert.ok(stepIds.includes(t.from), `transition.from ${t.from} resolves`);
    assert.ok(stepIds.includes(t.to), `transition.to ${t.to} resolves`);
  }
});

test('W10-A3: NodeProtocol completion evidence requires a human-receipt', () => {
  const categories = DIRECTOR_SIGNOFF_NODE_PROTOCOL.nodeCompletionEvidence.map((e) => e.category);
  assert.ok(categories.includes('human-receipt'), 'node completion requires a human-receipt');
});

// ---------------------------------------------------------------------------
// 3. Human-node definition shape (one human node + interactionContract + 2
//    terminal outcomes).
// ---------------------------------------------------------------------------

test('W10-A3: definition has exactly one Human node with an interactionContract', () => {
  const flow = humanDirectorApprovalModule.flow;
  assert.equal(flow.nodes.length, 1, 'exactly one flow node');
  const node = flow.nodes[0];
  assert.equal(node.id, 'director-signoff', 'node.id');
  assert.equal(node.kind, 'human', 'node.kind is human');
  assert.ok(node.interactionContract, 'Human node carries an interactionContract');
  assert.equal(
    node.interactionContract.id,
    HUMAN_DIRECTOR_INTERACTION_CONTRACT,
    'interactionContract.id',
  );
  assert.deepEqual(
    flow.terminalNodeIds,
    ['director-signoff'],
    'the single node is terminal',
  );
});

test('W10-A3: definition declares exactly two terminal outcomes (approved/rejected)', () => {
  const codes = humanDirectorApprovalModule.outcomes.map((o) => o.code).sort();
  assert.deepEqual(codes, ['approved', 'rejected'], 'two outcomes: approved + rejected');
  for (const o of humanDirectorApprovalModule.outcomes) {
    assert.equal(o.terminal, true, `outcome ${o.code} is terminal`);
  }
});

test('W10-A3: Human module carries NO LM execution profiles (kind-agnostic SPI proof)', () => {
  assert.equal(
    humanDirectorApprovalModule.executionProfiles.length,
    0,
    'Human module has no LM execution profile — the SPI is module-kind-agnostic',
  );
});

test('W10-A3: artifact authority is human and matches the output schema', () => {
  assert.equal(humanDirectorApprovalModule.artifacts.length, 1, 'one artifact type');
  const art = humanDirectorApprovalModule.artifacts[0];
  assert.equal(art.authority, 'human', 'artifact authority is human');
  assert.equal(art.schema.id, HUMAN_DIRECTOR_OUTPUT_SCHEMA, 'artifact schema is the output contract');
});

test('W10-A3: adapter reference is exact versioned (name@version)', () => {
  assert.equal(DIRECTOR_CONSOLE_ADAPTER_REF, 'director-console-adapter@1.0.0');
  assert.match(DIRECTOR_CONSOLE_ADAPTER_REF, /@/, 'adapter ref is name@version');
  assert.equal(HUMAN_DIRECTOR_ADAPTER_REFS.length, 1, 'one adapter ref');
  assert.equal(
    HUMAN_DIRECTOR_ADAPTER_REFS[0].adapterRef,
    DIRECTOR_CONSOLE_ADAPTER_REF,
    'adapter ref pinned on the node',
  );
});

test('W10-A3: handler refs index the interaction contract id', () => {
  assert.equal(HUMAN_DIRECTOR_HANDLER_REFS.length, 1, 'one handler ref');
  assert.equal(
    HUMAN_DIRECTOR_HANDLER_REFS[0].logicalId,
    HUMAN_DIRECTOR_INTERACTION_CONTRACT,
    'handler ref logicalId is the interaction contract id',
  );
});

// ---------------------------------------------------------------------------
// 4. Resource resolution. Every pinned resource resolves to a real file UNDER
//    the package root (proves module-relative resource resolution; no global
//    lookup, no traversal escape).
// ---------------------------------------------------------------------------

test('W10-A3: every manifest resourceIndex entry resolves under the package root', () => {
  assert.ok(
    HUMAN_DIRECTOR_RESOURCE_INDEX.length >= 5,
    'resource index has the pinned schemas + instruction + checklist',
  );
  const seenLogicalIds = new Set();
  for (const entry of HUMAN_DIRECTOR_RESOURCE_INDEX) {
    assert.ok(
      !seenLogicalIds.has(entry.logicalId),
      `resource logicalId '${entry.logicalId}' is unique`,
    );
    seenLogicalIds.add(entry.logicalId);
    const resolved = path.resolve(PACKAGE_ROOT, entry.path);
    assert.ok(
      resolved.startsWith(PACKAGE_ROOT + path.sep) || resolved === PACKAGE_ROOT,
      `resource '${entry.logicalId}' path '${entry.path}' must not escape the package root`,
    );
    assert.ok(existsSync(resolved), `resource '${entry.logicalId}' resolves at ${entry.path}`);
    assert.equal(entry.digest, 'pending@wave-2', `resource '${entry.logicalId}' digest is the Wave-2 placeholder`);
  }
});

test('W10-A3: every NodeProtocol resource pin resolves under the package root', () => {
  for (const entry of DIRECTOR_SIGNOFF_NODE_RESOURCES) {
    const resolved = path.resolve(PACKAGE_ROOT, entry.path);
    assert.ok(
      resolved.startsWith(PACKAGE_ROOT),
      `node resource '${entry.logicalId}' must not escape the package root`,
    );
    assert.ok(existsSync(resolved), `node resource '${entry.logicalId}' resolves at ${entry.path}`);
  }
});

test('W10-A3: NodeProtocol resource logicalIds are a subset of the manifest resourceIndex', () => {
  // The protocol pins resources by logicalId; each must exist in the manifest's
  // resource index so the runtime can resolve them through the package.
  const manifestIds = new Set(HUMAN_DIRECTOR_RESOURCE_INDEX.map((e) => e.logicalId));
  for (const entry of DIRECTOR_SIGNOFF_NODE_RESOURCES) {
    assert.ok(
      manifestIds.has(entry.logicalId),
      `protocol resource '${entry.logicalId}' is declared in the manifest resourceIndex`,
    );
  }
});

test('W10-A3: schema $id values match the contract ids the definition declares', () => {
  const interaction = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'schemas/director-signoff.schema.json'), 'utf8'),
  );
  const input = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'schemas/director-signoff-input.schema.json'), 'utf8'),
  );
  const output = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'schemas/director-signoff-output.schema.json'), 'utf8'),
  );
  assert.equal(interaction.$id, HUMAN_DIRECTOR_INTERACTION_CONTRACT, 'interaction schema $id');
  assert.equal(input.$id, HUMAN_DIRECTOR_INPUT_SCHEMA, 'input schema $id');
  assert.equal(output.$id, HUMAN_DIRECTOR_OUTPUT_SCHEMA, 'output schema $id');
});

// ---------------------------------------------------------------------------
// 5. Import-boundary proof (WAVE10-EXTENSIBILITY-SPEC §4). Scan the package's
//    own .ts source for relative imports and assert each one resolves into the
//    ALLOWED set (pure SPI under src/process-modules/{domain,application,
//    installation}) and NEVER into the FORBIDDEN set (src/index, modules/catalog,
//    composition root, tracker-view, other modules-ext packages). This is the
//    §0.13.10 extensibility proof in test form.
// ---------------------------------------------------------------------------

/**
 * The allowed import roots for an external package (WAVE10-EXTENSIBILITY-SPEC
 * §4: "imports ONLY from installation/, domain/spi/, application/ services").
 * Paths are repo-relative POSIX prefixes the resolved target must start with.
 */
const ALLOWED_IMPORT_ROOTS = [
  // Pure SPI surface (types + validators).
  'src/process-modules/domain/spi/',
  // Pure domain types (ProcessModuleDefinition / FlowDefinition).
  'src/process-modules/domain/',
  // Application-layer services (registries, executors) — read-only consumption.
  'src/process-modules/application/',
  // Installation surface (package installer / store).
  'src/process-modules/installation/',
  // The package's own internal siblings.
  'modules-ext/human-director-approval/',
];

/** Resolved import targets that must NEVER appear (the forbidden set). */
const FORBIDDEN_IMPORT_TARGETS = [
  'src/index.ts',
  'src/index.js',
  'src/process-modules/modules/catalog.ts',
  'src/process-modules/modules/catalog.js',
  'src/process-modules/modules/installations.ts',
  'src/process-modules/composition/product-lifecycle-runtime.ts',
];

/**
 * Resolve a relative import specifier to a repo-relative POSIX path.
 *
 * The package consumes the SPI through the root-compiled `dist/` output (the
 * canonical form `npm run build` emits, mirroring `src/` 1:1). To evaluate the
 * boundary against the SOURCE layout, normalize a `dist/process-modules/...`
 * target back to its canonical `src/process-modules/...` source path. This
 * keeps the assertion faithful: the package imports only the SPI surface,
 * whether the specifier resolves to the source tree or its compiled mirror.
 */
function resolvePackageImport(fromFile, spec) {
  const absolute = path.resolve(path.dirname(fromFile), spec);
  let rel = path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
  // Normalize the compiled mirror back to its source path so the boundary is
  // evaluated against the canonical src/ layout.
  if (rel.startsWith('dist/process-modules/')) {
    rel = 'src/' + rel.slice('dist/'.length);
  }
  return rel;
}

/** Recursively collect every .ts file under the package src/. */
function collectPackageTs(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectPackageTs(full, acc);
    } else if (st.isFile() && full.endsWith('.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const RELATIVE_IMPORT_RE =
  /(?:^|\n)[ \t]*(?:import|export)[^;]*?\bfrom\s*['"]([.][./][^'"]+)['"]/g;

test('W10-A3: package imports ONLY the allowed SPI surface (§0.13.10 proof)', () => {
  const files = collectPackageTs(path.join(PACKAGE_ROOT, 'src'));
  assert.ok(files.length >= 3, `expected >=3 package .ts files, got ${files.length}`);
  /** @type {{file:string, spec:string, resolved:string}[]} */
  const offenders = [];
  /** @type {{file:string, spec:string, resolved:string}[]} */
  const forbidden = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    let match;
    RELATIVE_IMPORT_RE.lastIndex = 0;
    while ((match = RELATIVE_IMPORT_RE.exec(src)) !== null) {
      const spec = match[1];
      // Bare specifiers (node:fs, @scope/pkg) are not architectural edges.
      if (spec[0] !== '.') continue;
      const resolved = resolvePackageImport(file, spec);
      // The package's own internal imports are allowed.
      const isOwnSibling = resolved.startsWith('modules-ext/human-director-approval/');
      const isAllowedSpi = ALLOWED_IMPORT_ROOTS.some((root) => resolved.startsWith(root));
      if (!isAllowedSpi) {
        offenders.push({ file: path.relative(REPO_ROOT, file), spec, resolved });
      }
      // Forbidden targets are checked regardless of allowed-root membership.
      for (const bad of FORBIDDEN_IMPORT_TARGETS) {
        if (resolved === bad || resolved.replace(/\.js$/, '.ts') === bad) {
          forbidden.push({ file: path.relative(REPO_ROOT, file), spec, resolved });
        }
      }
      // The package must not import another modules-ext package (no cross-talk).
      if (
        resolved.startsWith('modules-ext/') &&
        !resolved.startsWith('modules-ext/human-director-approval/')
      ) {
        offenders.push({ file: path.relative(REPO_ROOT, file), spec, resolved });
      }
      void isOwnSibling;
    }
  }
  if (offenders.length > 0) {
    const lines = offenders.map(
      (o) => `  ${o.file}: '${o.spec}' -> ${o.resolved}`,
    );
    assert.fail(
      `Package imports ${offenders.length} non-allowlisted target(s). ` +
        `WAVE10-EXTENSIBILITY-SPEC §4 forbids imports outside the pure SPI:\n${lines.join('\n')}`,
    );
  }
  if (forbidden.length > 0) {
    const lines = forbidden.map(
      (o) => `  ${o.file}: '${o.spec}' -> ${o.resolved}`,
    );
    assert.fail(
      `Package imports ${forbidden.length} forbidden target(s):\n${lines.join('\n')}`,
    );
  }
});

test('W10-A3: package does NOT switch on built-in module names (no catalog coupling)', () => {
  // A truly extensible package never names the built-in modules. Scan the
  // package source for the four built-in module-name literals.
  const BUILTIN_MODULES = [
    "'discovery'", '"discovery"',
    "'formalization'", '"formalization"',
    "'development'", '"development"',
    "'delivery'", '"delivery"',
  ];
  const files = collectPackageTs(path.join(PACKAGE_ROOT, 'src'));
  const hits = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const lit of BUILTIN_MODULES) {
      if (src.includes(lit)) {
        hits.push(`${path.relative(REPO_ROOT, file)}: ${lit}`);
      }
    }
  }
  if (hits.length > 0) {
    assert.fail(
      `Package source references built-in module names — extensibility leak:\n${hits.join('\n')}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Package self-containment. The package ships an installable package.json
//    and a tsconfig; assert the metadata is coherent.
// ---------------------------------------------------------------------------

test('W10-A3: package.json metadata matches the module identity', () => {
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@saga-ext/human-director-approval', 'npm package name');
  assert.equal(pkg.version, '1.0.0', 'npm package version');
  assert.equal(pkg.type, 'module', 'ESM package');
  assert.equal(pkg.saga.moduleRef, 'human-director-approval@1.0.0', 'saga.moduleRef');
  assert.equal(pkg.saga.packageKind, 'human-approval', 'saga.packageKind');
  assert.equal(pkg.saga.manifestFormatVersion, '1', 'saga.manifestFormatVersion');
  assert.equal(pkg.saga.runtimeCompatibilityRange, '^3.0.0', 'saga.runtimeCompatibilityRange');
});
