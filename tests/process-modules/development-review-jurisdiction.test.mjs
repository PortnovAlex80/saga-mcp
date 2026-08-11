import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { DEVELOPMENT_RESOURCE_INDEX } from '../../dist/process-modules/modules/development/package/manifest.js';

test('implementation reviewers use the package-pinned scope-aware reviewer skill', () => {
  const profile = developmentProcessModule.executionProfiles.find(
    candidate => candidate.id === 'development-implementation-reviewer',
  );
  assert.ok(profile);
  assert.equal(profile.executionSkill, 'saga-development-code-reviewer');
  assert.equal(profile.semanticSkill, 'saga-development-code-reviewer');

  const resource = DEVELOPMENT_RESOURCE_INDEX.find(
    candidate => candidate.logicalId === 'development.skill.implementation-reviewer',
  );
  assert.ok(resource);
  assert.match(resource.path, /saga-development-code-reviewer\/SKILL\.md$/);
});

test('review instructions forbid blockers owned by future scoped work items', () => {
  const reviewer = readFileSync(
    'src/process-modules/modules/development/package/resources/skills/saga-development-code-reviewer/SKILL.md',
    'utf8',
  );
  const fallback = readFileSync(
    'src/process-modules/modules/development/package/resources/skills/saga-worker/SKILL.md',
    'utf8',
  );

  assert.match(reviewer, /blocking finding must be remediable within .*`changeScopes`/s);
  assert.match(reviewer, /Do not request global files, tests, or\s+launch wiring assigned to another future item/);
  assert.match(fallback, /MUST NOT produce `changes_requested`/);
  assert.match(fallback, /Never widen scope merely to make an\s+intermediate candidate globally runnable/);
});
