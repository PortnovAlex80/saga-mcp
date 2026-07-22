/** Filesystem adapter for accepted artifact proposals. */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactWriter } from '../../control/ports/worker-submission-ports.js';

export class WorkspaceArtifactWriter implements ArtifactWriter {
  constructor(private readonly workspaceRoot: string) {}

  write(input: {
    readonly path: string;
    readonly content: string;
    readonly expectedDigest: string;
  }): { readonly path: string; readonly digest: string } {
    const relativePath = input.path.split('#')[0];
    const root = path.resolve(this.workspaceRoot);
    const absolute = path.resolve(root, relativePath);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new Error(`Artifact path escapes workspace: ${input.path}`);
    }

    const digest = createHash('sha256').update(input.content).digest('hex');
    if (digest !== input.expectedDigest) {
      throw new Error(`Artifact digest changed before acceptance: ${relativePath}`);
    }

    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, input.content, 'utf8');
    return { path: relativePath, digest };
  }
}
