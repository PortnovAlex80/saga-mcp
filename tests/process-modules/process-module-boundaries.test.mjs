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
  // Wave 13 removed modules/catalog.ts; build the registry inline.
  const { ProcessModuleRegistry } = await import(
    '../../dist/process-modules/application/process-module-registry.js'
  );
  const { discoveryProcessModule } = await import(
    '../../dist/process-modules/modules/discovery/discovery-process-module.js'
  );
  const { formalizationProcessModule } = await import(
    '../../dist/process-modules/modules/formalization/formalization-process-module.js'
  );
  const { developmentProcessModule } = await import(
    '../../dist/process-modules/modules/development/development-process-module.js'
  );
  const { deliveryProcessModule } = await import(
    '../../dist/process-modules/modules/delivery/delivery-process-module.js'
  );
  const registry = new ProcessModuleRegistry();
  registry.register(discoveryProcessModule);
  registry.register(formalizationProcessModule);
  registry.register(developmentProcessModule);
  registry.register(deliveryProcessModule);

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
        // W13-A2: module-owned skills were moved out of the legacy global root
        // (`skills/<name>/`) into each module's package resources dir
        // (`src/process-modules/modules/<stage>/package/resources/skills/<name>/`).
        // Platform/shared skills (e.g. saga-process-module-worker-protocol)
        // remain at the repo-root `skills/` dir. A skill is valid if it resolves
        // in EITHER location. At runtime skills are resolved from the agent's
        // catalog (~/.<agent>/skills); this only asserts the source of truth.
        const platformSkillPath = path.join(ROOT, 'skills', skillName, 'SKILL.md');
        const packageSkillPath = path.join(
          ROOT,
          'src',
          'process-modules',
          'modules',
          module.identity.kind,
          'package',
          'resources',
          'skills',
          skillName,
          'SKILL.md',
        );
        assert.equal(
          existsSync(platformSkillPath) || existsSync(packageSkillPath),
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
