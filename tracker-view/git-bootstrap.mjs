import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Ensure a repository capability suitable for lifecycle pinning.
 *
 * The bootstrap creates one Saga-owned marker commit when HEAD is absent. It
 * never stages pre-existing user files, so selecting an existing directory
 * cannot silently import unrelated content into the first Saga commit.
 */
export function ensureInitializedGitRepository(localPath, projectName) {
  if (!existsSync(localPath)) mkdirSync(localPath, { recursive: true });
  const git = (...args) => execFileSync('git', args, {
    cwd: localPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  if (!existsSync(path.join(localPath, '.git'))) {
    git('init', '-q', '-b', 'main');
  }
  git('config', 'user.email', 'saga-bootstrap@local.invalid');
  git('config', 'user.name', 'Saga Bootstrap');

  try {
    const existing = git('rev-parse', '--verify', 'HEAD');
    if (!/^[0-9a-f]{7,40}$/i.test(existing)) {
      throw new Error('git returned a malformed HEAD');
    }
    return existing;
  } catch {
    const markerPath = path.join(localPath, '.saga-bootstrap.md');
    if (!existsSync(markerPath)) {
      writeFileSync(
        markerPath,
        `# ${projectName}\n\nInitialized by Saga from a product idea.\n`,
        'utf8',
      );
    }
    git('add', '--', '.saga-bootstrap.md');
    git('commit', '-q', '-m', 'chore: initialize Saga project');
    const head = git('rev-parse', '--verify', 'HEAD');
    if (!/^[0-9a-f]{7,40}$/i.test(head)) {
      throw new Error('initial commit did not produce a valid HEAD');
    }
    return head;
  }
}
