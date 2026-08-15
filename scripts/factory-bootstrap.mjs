#!/usr/bin/env node
/**
 * Compatibility wrapper for the canonical Factory gateway.
 *
 * New automation should call `scripts/factory.mjs start` directly. This file
 * retains the historical positional interface without retaining a second
 * schema/order/launch implementation.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const sandboxName = process.argv[2];
const modelName = process.argv[3];
const idea = process.argv.slice(4).join(' ').trim();

if (!sandboxName || !modelName || !idea) {
  process.stderr.write(
    'Usage: node scripts/factory-bootstrap.mjs <sandbox-name> <model-name> <idea-text>\n',
  );
  process.exit(2);
}

const sandboxRoot = resolve(`.factory-sandboxes/${sandboxName}`);
const dbPath = resolve(sandboxRoot, 'factory.sqlite');
const factoryEntry = resolve('scripts/factory.mjs');
const result = spawnSync(
  process.execPath,
  [
    factoryEntry,
    'start',
    dbPath,
    idea,
    '--model',
    modelName,
    '--sandbox',
    sandboxRoot,
  ],
  { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
