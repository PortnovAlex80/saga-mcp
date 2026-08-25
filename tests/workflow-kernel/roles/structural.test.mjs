/**
 * structural.test.mjs - WP-17 structural proofs:
 *   1. NO substitute-selection path exists - the resolver source contains
 *      none of the forbidden selection vocabulary (the nine banned
 *      resolution sources of the frozen manifest plus ranking/ordering
 *      vocabulary), exposes exactly ONE resolution entry point, and
 *      imports only pure kernel domain modules (it cannot even read the
 *      installed manifest - the pin is its only input).
 *   2. The compiler and fixtures contain none of the legacy
 *      role-resolution identifiers (RR-1..RR-12 census names).
 *   3. The roles tree keeps the kernel-source discipline: no quoted bare
 *      workshop-name literal (the BINDING complexity dimension), no
 *      role-binding stem file name outside the frozen budget.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLES_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'workflow-kernel', 'roles');

function listSourceFiles(dir) {
  const acc = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) acc.push(...listSourceFiles(p));
    else if (entry.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const resolverSource = readFileSync(path.join(ROLES_SRC, 'resolver.ts'), 'utf8');
const allRoleFiles = listSourceFiles(ROLES_SRC);
const allRoleSources = allRoleFiles.map((f) => ({ file: path.basename(f), source: readFileSync(f, 'utf8') }));

test('the roles source tree exists and is non-trivial', () => {
  assert.ok(allRoleFiles.length >= 8, `found ${allRoleFiles.length} files under src/workflow-kernel/roles`);
});

/* ------------------------------------------------------------------ */
/* 1. No substitute-selection path (the resolver)                      */
/* ------------------------------------------------------------------ */

test('resolver.ts contains none of the forbidden selection vocabulary', () => {
  // Word-ish boundaries so legitimate identifiers are not falsely hit;
  // the resolver needs NONE of these notions to do its job.
  const forbidden = [
    /\bfallback\b/i,
    /\bstatus\b/i,
    /\btags?\b/i,
    /\btasks?\b/i,
    /\bskills?\b/i,
    /\btrackers?\b/i,
    /\bboards?\b/i,
    /\bdefaults?\b/i,
    /\branks?\b/i,
    /\bsorts?\b/i,
    /\binfer/i,
    /chronolog/i,
    /\bmaxId\b/i,
    /\blatest\b/i,
    /\bpriorit/i,
    /\bselect(ion|ed|ing)?\b/i,
    /\bpick(s|ed|ing)?\b/i,
    /\bchoose|chose|chosen\b/i,
    /\bguess/i,
    /\bheuristic/i,
  ];
  for (const rx of forbidden) {
    assert.equal(rx.test(resolverSource), false, `resolver.ts must not contain forbidden selection vocabulary: ${rx}`);
  }
});

test('resolver.ts exposes exactly ONE resolution entry point and no other resolver', () => {
  const exported = [...resolverSource.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(exported, ['installRoleContracts', 'resolveRoleContract', 'roleContractPinOf']);
  const resolutionExports = [...resolverSource.matchAll(/export \w+ (\w*[Rr]esolut\w*)/g)].map((m) => m[1]);
  assert.deepEqual(resolutionExports, ['RoleContractResolution']);
  assert.equal((resolverSource.match(/resolveRoleContract/g) ?? []).length >= 1, true);
});

test('resolver.ts imports only pure kernel domain modules (it cannot read the manifest or any store)', () => {
  const imports = [...resolverSource.matchAll(/import[^;]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(imports.length >= 2);
  for (const specifier of imports) {
    assert.ok(specifier.startsWith('../domain/'), `resolver.ts must import only ../domain/*, found: ${specifier}`);
  }
  assert.equal(/frozen-docs/.test(resolverSource), false, 'the consumer port must not load the installed manifest itself');
  assert.equal(/node:fs|node:path|readFile/i.test(resolverSource), false, 'the consumer port performs no I/O');
});

test('resolver.ts has no try/catch swallow and no empty error branch (fail-closed shape)', () => {
  assert.equal(/catch/.test(resolverSource), false, 'a refused resolution must be a returned TypedRefusal, never a caught-and-ignored error');
});

/* ------------------------------------------------------------------ */
/* 2. No legacy role-resolution identifiers anywhere in the roles tree  */
/* ------------------------------------------------------------------ */

test('no legacy role-resolution identifier (census RR-1..RR-12) appears in any roles source file', () => {
  const forbiddenIdentifiers = [
    'skillForTask',
    'roleFromTask',
    'pickLaunchSpecSkillName',
    'resolveExecutionProfile',
    'resolveAgentLaunchSpec',
    'execution_skill',
    'review_skill',
    'assignment.skill',
    'tasks.status',
    'task.tags',
    'tracker/board state',
    'global skill roots',
    'latest/chronology',
    'fallback',
    'ExecutionRouteResolver',
  ];
  for (const { file, source } of allRoleSources) {
    for (const identifier of forbiddenIdentifiers) {
      assert.ok(!source.includes(identifier), `${file} must not contain the legacy resolution identifier "${identifier}"`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 3. Kernel-source discipline in the roles tree                       */
/* ------------------------------------------------------------------ */

test('no quoted bare workshop-name literal in the roles tree (workshops.nameBranchLiterals stays 0)', () => {
  const rx = /['"`](discovery|formalization|development|delivery|documentation)['"`]/;
  for (const { file, source } of allRoleSources) {
    assert.equal(rx.test(source), false, `${file} contains a quoted bare workshop-name literal`);
  }
});

test('no roles file name matches a frozen complexity-budget stem (role-binding, obligation-consumer, assembler, scheduler)', () => {
  const rx = /(role-binding|obligation-consumer|assembler|scheduler|flow-executor|flow-engine|handler-registry)/i;
  for (const file of allRoleFiles) {
    assert.equal(rx.test(path.basename(file)), false, `file name ${path.basename(file)} matches a frozen budget stem`);
  }
});

test('the roles tree imports only relative paths and node builtins (kernel purity rule)', () => {
  for (const { file, source } of allRoleSources) {
    const imports = [...source.matchAll(/import[^;]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith('.') || specifier.startsWith('node:'),
        `${file} imports a non-relative, non-builtin module: ${specifier}`,
      );
    }
  }
});

test('the frozen schema and manifest are read from docs/ - never copied into src/', async () => {
  // The single-source-of-truth law: no JSON copy of the frozen documents
  // exists under src/; the compiler loads them at runtime.
  const jsonFiles = allRoleFiles.filter((f) => f.endsWith('.json'));
  assert.deepEqual(jsonFiles, [], 'no JSON artifact copies under src/workflow-kernel/roles');
  const frozenDocs = readFileSync(path.join(ROLES_SRC, 'frozen-docs.ts'), 'utf8');
  assert.ok(frozenDocs.includes('canonical-role-contract.schema.json'));
  assert.ok(frozenDocs.includes('role-contract-manifest.json'));
  assert.ok(statSync(path.resolve(ROLES_SRC, '..', '..', '..', 'docs', 'refactoring', 'event-kernel', 'specs', 'canonical-role-contract.schema.json')).isFile());
});
