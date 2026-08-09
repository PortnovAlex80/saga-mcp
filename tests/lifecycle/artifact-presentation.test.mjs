import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  artifactFallbackDocument,
  orderedArtifactTypes,
  structurallyUnreachableArtifacts,
} from '../../tracker-view/artifact-presentation.mjs';

test('artifact menu orders known types first and retains every new module-defined type', () => {
  const ordered = orderedArtifactTypes([
    { type: 'hypothesis' },
    { type: 'PRD' },
    { type: 'business_metric' },
    { type: 'brief' },
    { type: 'hypothesis' },
  ]);

  assert.deepEqual(ordered, [
    'PRD',
    'brief',
    'business_metric',
    'hypothesis',
  ]);
});

test('document projection exposes cyclic and missing-parent rows instead of hiding them', () => {
  const artifacts = [
    { id: 1, parent_artifact_id: 1, title: 'self cycle' },
    { id: 2, parent_artifact_id: null, title: 'root' },
    { id: 3, parent_artifact_id: 2, title: 'reachable child' },
    { id: 4, parent_artifact_id: 5, title: 'cycle a' },
    { id: 5, parent_artifact_id: 4, title: 'cycle b' },
    { id: 6, parent_artifact_id: 999, title: 'missing parent' },
  ];

  assert.deepEqual(
    structurallyUnreachableArtifacts(artifacts).map(artifact => artifact.id),
    [1, 4, 5, 6],
  );
});

test('artifact fallback renders a module-provided database document verbatim', () => {
  const fallback = artifactFallbackDocument({
    title: 'Discovery Brief',
    metadata: JSON.stringify({
      document_markdown: '# Canonical brief\n\nThe durable document.',
    }),
  });

  assert.equal(fallback.source, 'database document projection');
  assert.equal(fallback.markdown, '# Canonical brief\n\nThe durable document.');
});

test('artifact fallback renders a durable brief payload without requiring a repository file', () => {
  const fallback = artifactFallbackDocument({
    title: 'Discovery Brief',
    metadata: {
      brief_payload: {
        decision: 'go',
        goals: ['accessible buttons', 'low sensory load'],
      },
    },
  });

  assert.equal(fallback.source, 'database brief payload');
  assert.match(fallback.markdown, /^# Discovery Brief/m);
  assert.match(fallback.markdown, /## decision\n\ngo/);
  assert.match(fallback.markdown, /- accessible buttons/);
});

test('artifact fallback never invents missing product content', () => {
  const fallback = artifactFallbackDocument({
    title: 'Synthetic brief',
    type: 'brief',
    code: 'BRIEF-1',
    status: 'accepted',
    path: 'docs/discovery/brief-auto-provisioned.md',
    content_hash: 'abc',
    accepted_hash: 'abc',
    drift_state: 'clean',
    metadata: '{}',
  });

  assert.equal(fallback.source, 'database artifact record');
  assert.match(fallback.markdown, /repository file is absent/i);
  assert.match(fallback.markdown, /Declared path: docs\/discovery\/brief-auto-provisioned\.md/);
  assert.doesNotMatch(fallback.markdown, /problem statement/i);
});

test('tracker artifact tree links orphan titles and uses the complete dynamic type order', () => {
  // T10 step 6: renderArtifacts (which contains these patterns) was extracted
  // from tracker-view.mjs into tracker-view/artifact-render.mjs. Assert against
  // the extracted module.
  const renderSource = readFileSync(
    path.join(import.meta.dirname, '..', '..', 'tracker-view', 'artifact-render.mjs'),
    'utf8',
  );

  assert.match(renderSource, /const typeOrder = orderedArtifactTypes\(artifacts\)/);
  assert.match(
    renderSource,
    /<a class="atitle" href="\/\?artifact=\$\{o\.id\}">\$\{esc\(o\.title\)\}<\/a>/,
  );
  assert.match(
    renderSource,
    /<a class="tg tg-link" href="\/\?artifact=\$\{t\.target_id\}">/,
  );
});
