import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureInitializedGitRepository } from '../../tracker-view/git-bootstrap.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('git bootstrap creates a real main HEAD without staging existing files', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-git-bootstrap-'));
  try {
    writeFileSync(path.join(dir, 'unrelated.txt'), 'do not stage\n');
    const head = ensureInitializedGitRepository(dir, 'Example');
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(git(dir, 'branch', '--show-current'), 'main');
    assert.equal(git(dir, 'show', '--pretty=', '--name-only', 'HEAD'), '.saga-bootstrap.md');
    assert.equal(git(dir, 'status', '--short'), '?? unrelated.txt');
    assert.ok(existsSync(path.join(dir, '.saga-bootstrap.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git bootstrap reuses an existing HEAD without adding a commit', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-git-existing-'));
  try {
    const first = ensureInitializedGitRepository(dir, 'Example');
    const second = ensureInitializedGitRepository(dir, 'Example');
    assert.equal(second, first);
    assert.match(readFileSync(path.join(dir, '.saga-bootstrap.md'), 'utf8'), /Example/);
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
