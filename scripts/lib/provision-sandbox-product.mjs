// Sandbox product-repository provisioning, extracted from scripts/factory.mjs
// `start` so tests can verify the filesystem contract directly (factory.mjs
// executes its CLI dispatch at import time).
//
// The product repository gets a minimal AGENTS.md workspace marker: agent
// backends that probe for a workspace anchor (opencode walks up from cwd when
// a repository exposes no agent-facing marker) then treat the product itself
// as the session workspace instead of climbing to the outer factory repo.
// See docs/factory-run/stage11/DISORIENTATION-INVESTIGATION.md (fix 2).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function productAgentsMarker(sandboxName) {
  return [
    `# ${sandboxName} product workspace`,
    '',
    'This repository is the product sandbox of a saga factory run.',
    'It is the working root for every worker agent session: resolve all',
    'relative paths from this repository, not from the outer factory repo.',
    '',
  ].join('\n');
}

/**
 * Provision `<root>/product` as a fresh git repository with the factory's
 * committer identity, a README, and the AGENTS.md workspace marker committed
 * on the initial commit. Destructive: wipes `root` when it already exists
 * (same contract the inline block in `factory.mjs start` always had).
 */
export function provisionSandboxProduct(root, sandboxName) {
  const repositoryPath = path.join(root, 'product');
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(repositoryPath, { recursive: true });

  function git(gitArgs) {
    const result = spawnSync('git', gitArgs, { cwd: repositoryPath, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Saga Factory']);
  git(['config', 'user.email', 'saga-factory@example.test']);
  writeFileSync(path.join(repositoryPath, 'README.md'), `# ${sandboxName}\n`);
  writeFileSync(path.join(repositoryPath, 'AGENTS.md'), productAgentsMarker(sandboxName));
  git(['add', '-A']);
  git(['commit', '-m', 'chore: initialize product']);
  git(['checkout', '-b', 'dev']);
  git(['rev-parse', 'HEAD']);

  return repositoryPath;
}
