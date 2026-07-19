// Unit tests for the docs-graph scanner.
// Run: node --test tests/docs-graph-scanner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontMatter, scanMarkdownFiles } from '../tracker-view/docs-graph/lib/scanner.mjs';

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'docs-graph-scan-'));
  // Plain .md with H1 fallback title.
  writeFileSync(join(root, 'README.md'), '# Project README\n\nWelcome.\n');
  // .md with YAML front-matter.
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'req.md'),
    '---\ntitle: Requirements\ncode: PRD-1\nstatus: accepted\n---\n\n# Override H1\n',
  );
  // An orphan doc deep in a tree.
  mkdirSync(join(root, 'docs', 'sub'), { recursive: true });
  writeFileSync(join(root, 'docs', 'sub', 'note.md'), '# Note\nbody\n');
  // Non-markdown file — must be ignored.
  writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  // Files inside ignored directories.
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'lib.md'), '# Should be ignored\n');
  mkdirSync(join(root, '.worktrees', 'task-1'), { recursive: true });
  writeFileSync(join(root, '.worktrees', 'task-1', 'work.md'), '# Ignored too\n');
  return root;
}

test('parseFrontMatter reads title/status/code', () => {
  const fm = parseFrontMatter('---\ntitle: Hello\nstatus: draft\ncode: AC-1\n---\nbody');
  assert.equal(fm.title, 'Hello');
  assert.equal(fm.status, 'draft');
  assert.equal(fm.code, 'AC-1');
});

test('parseFrontMatter returns empty when no block', () => {
  assert.deepEqual(parseFrontMatter('# just a heading'), {});
  assert.deepEqual(parseFrontMatter('---\nno closing marker'), {});
});

test('parseFrontMatter strips surrounding quotes', () => {
  const fm = parseFrontMatter('---\ntitle: "Quoted title"\n---\n');
  assert.equal(fm.title, 'Quoted title');
});

test('scanMarkdownFiles finds all .md under root, ignores noise', () => {
  const root = makeFixture();
  try {
    const docs = scanMarkdownFiles(root);
    const relPaths = docs.map((d) => d.relPath).sort();
    assert.deepEqual(relPaths, ['README.md', 'docs/req.md', 'docs/sub/note.md'].sort());
    // No png, no node_modules, no .worktrees leaks.
    assert.ok(!relPaths.some((p) => p.endsWith('.png')));
    assert.ok(!relPaths.some((p) => p.includes('node_modules')));
    assert.ok(!relPaths.some((p) => p.includes('.worktrees')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanMarkdownFiles extracts titles: front-matter wins, H1 as fallback', () => {
  const root = makeFixture();
  try {
    const docs = scanMarkdownFiles(root);
    const byPath = new Map(docs.map((d) => [d.relPath, d]));
    assert.equal(byPath.get('docs/req.md').title, 'Requirements');
    assert.equal(byPath.get('docs/req.md').frontMatter.code, 'PRD-1');
    assert.equal(byPath.get('docs/req.md').frontMatter.status, 'accepted');
    assert.equal(byPath.get('README.md').title, 'Project README');
    assert.equal(byPath.get('docs/sub/note.md').title, 'Note');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanMarkdownFiles computes sha256 of content', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-graph-hash-'));
  try {
    writeFileSync(join(root, 'a.md'), 'same body');
    const docs = scanMarkdownFiles(root);
    assert.equal(docs.length, 1);
    const expected = createHash('sha256').update('same body').digest('hex');
    assert.equal(docs[0].sha256, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
