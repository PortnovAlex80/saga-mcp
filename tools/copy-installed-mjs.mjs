#!/usr/bin/env node
// FRF-WP11 — the installed-package .mjs asset copy step of `npm run build`.
//
// tsc compiles src/**/*.ts only; the Formalization package's installed
// semantic surfaces include .mjs modules (the WP03 contracts at their
// canonical home src/workflow-kernel/workshops/formalization/contracts/
// and the .mjs cells: acceptance + what-freeze + the Development handoff
// desks). dist/ is the installed package surface, so the build mirrors
// those .mjs trees into dist byte-identically (together with the frozen
// .json schemas). The FRF removal guard asserts the dist copies stay
// byte-equal to src (a drifted emit is a red build).
//
// Deterministic: plain file copy, no transformation, sorted walk.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The installed .mjs/.json asset trees of the Formalization package (src -> dist). */
const INSTALLED_ASSET_TREES = [
  'src/workflow-kernel/workshops/formalization/contracts',
  'src/workflow-kernel/workshops/formalization/cells/acceptance',
  'src/workflow-kernel/workshops/formalization/cells/what-freeze',
  'src/workflow-kernel/workshops/development/handoff',
];

/** Single installed .mjs files outside the trees above (src -> dist). */
const INSTALLED_ASSET_FILES = [
  'src/workflow-kernel/workshops/formalization/cells/dispatch.mjs',
];

const ASSET_EXTENSIONS = new Set(['.mjs', '.json']);

function copyTree(relDir) {
  const src = join(root, relDir);
  if (!existsSync(src)) return 0;
  const dist = join(root, 'dist', relDir.replace(/^src[\/]/, ''));
  let copied = 0;
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from).sort()) {
      const fromPath = join(from, name);
      const toPath = join(to, name);
      if (statSync(fromPath).isDirectory()) {
        walk(fromPath, toPath);
      } else {
        const dot = name.lastIndexOf('.');
        if (dot > 0 && ASSET_EXTENSIONS.has(name.slice(dot))) {
          cpSync(fromPath, toPath);
          copied += 1;
        }
      }
    }
  };
  walk(src, dist);
  return copied;
}

let total = 0;
for (const tree of INSTALLED_ASSET_TREES) total += copyTree(tree);
for (const file of INSTALLED_ASSET_FILES) {
  cpSync(join(root, file), join(root, 'dist', file.replace(/^src[\/]/, '')));
  total += 1;
}
console.log(`[copy-installed-mjs] mirrored ${total} installed asset file(s) into dist/`);
