/**
 * Concrete GitPort + MachinePort implementations (Wave 7 hex extraction).
 *
 * These are the infrastructure-side adapters for the Development module's
 * driver-neutral ports (development-kernel-ports GitPort / MachinePort). They
 * keep `child_process` and `node:os` out of the module — the module speaks the
 * port, this file owns the shell-out.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import type { GitPort, MachinePort } from '../../process-modules/modules/development/development-kernel-ports.js';

/** A read-only git client backed by `git -C <repoPath>` shell-outs. */
export function createGitPort(): GitPort {
  return {
    read(repoPath, args) {
      const result = spawnSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.status !== 0) return null;
      const value = (result.stdout ?? '').trim();
      return value.length > 0 ? value : null;
    },
    ok(repoPath, args) {
      return spawnSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8',
        windowsHide: true,
      }).status === 0;
    },
  };
}

/** A machine-identity client backed by `os.hostname()`. */
export function createMachinePort(): MachinePort {
  return {
    hostname: () => os.hostname(),
  };
}
