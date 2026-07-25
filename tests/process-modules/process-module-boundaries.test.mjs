import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = (...parts) => path.join(ROOT, 'src', ...parts);

const RUNTIME_FILES = [
  SRC('process-modules', 'domain', 'process-module.ts'),
  SRC('process-modules', 'domain', 'lifecycle.ts'),
  SRC('process-modules', 'application', 'validate-process-module.ts'),
  SRC('process-modules', 'application', 'process-module-registry.ts'),
  SRC('process-modules', 'application', 'lifecycle-router.ts'),
  SRC('process-modules', 'application', 'process-module-runtime-engine.ts'),
];

test('Process Module runtime core does not import Discovery or Formalization semantics', () => {
  for (const file of RUNTIME_FILES) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /from ['"].*(modules\/discovery|modules\/formalization|saga3\/domain\/discovery)/,
      `${path.relative(ROOT, file)} must stay process-agnostic`,
    );
  }
});

test('Discovery module does not import or start Formalization', () => {
  const file = SRC('process-modules', 'modules', 'discovery', 'discovery-process-module.ts');
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /modules\/formalization/);
  assert.doesNotMatch(source, /solution-formalization/);
  assert.doesNotMatch(source, /startFormalization|runFormalization/);
});

test('Formalization module does not import or start Discovery', () => {
  const file = SRC('process-modules', 'modules', 'formalization', 'formalization-process-module.ts');
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /modules\/discovery/);
  assert.doesNotMatch(source, /startDiscovery|runDiscovery/);
});

test('module asset and skill references exist', async () => {
  const { createBuiltInProcessModuleRegistry } = await import(
    '../../dist/process-modules/modules/catalog.js'
  );
  const registry = createBuiltInProcessModuleRegistry();

  for (const module of registry.list()) {
    for (const profile of module.executionProfiles) {
      const paths = [
        profile.trackerTemplate,
        ...profile.workspaceTemplates,
        ...profile.callTemplates,
        ...profile.checklists,
      ].filter(Boolean);
      for (const referencedPath of new Set(paths)) {
        assert.equal(
          existsSync(path.join(ROOT, referencedPath)),
          true,
          `${module.identity.name}/${profile.id} references missing asset ${referencedPath}`,
        );
      }

      for (const skillName of new Set([
        profile.executionSkill,
        profile.protocolSkill,
        profile.semanticSkill,
      ])) {
        const skillPath = path.join(ROOT, 'skills', skillName, 'SKILL.md');
        assert.equal(
          existsSync(skillPath),
          true,
          `${module.identity.name}/${profile.id} references missing skill ${skillName}`,
        );
      }
    }
  }
});

test('every Process Module design is guarded by the reusable checklist and skill', () => {
  const checklist = path.join(ROOT, 'docs', 'saga3', 'process-modules', 'PROCESS-MODULE-CHECKLIST.md');
  const skill = path.join(ROOT, 'skills', 'saga-process-module-designer', 'SKILL.md');
  const protocol = path.join(ROOT, 'skills', 'saga-process-module-worker-protocol', 'SKILL.md');
  assert.equal(existsSync(checklist), true);
  assert.equal(existsSync(skill), true);
  assert.equal(existsSync(protocol), true);
  const checklistSource = readFileSync(checklist, 'utf8');
  const skillSource = readFileSync(skill, 'utf8');
  const protocolSource = readFileSync(protocol, 'utf8');
  for (const term of ['WorkIntent', 'tracker', 'MCP', 'recovery', 'Stage Binding', 'machine-filled']) {
    assert.match(checklistSource, new RegExp(term, 'i'));
    assert.match(skillSource, new RegExp(term, 'i'));
    assert.match(protocolSource, new RegExp(term, 'i'));
  }
});
