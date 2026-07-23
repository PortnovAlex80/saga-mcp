#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const sourcePath = 'tools/apply-phase-b-pure-engine.mjs';
const generatedPath = 'tools/.apply-phase-b-pure-engine.generated.mjs';
let source = readFileSync(sourcePath, 'utf8');

const before = "replaceExact(orchestrate, `          resetHealRetriesForEpic(epicId);`, `          resetHealRetriesForEpic(epicId, state);`);";
const after = "replaceExact(orchestrate, `          resetHealRetriesForEpic(epicId);`, `          resetHealRetriesForEpic(epicId, state);`, 2);";
if (!source.includes(before)) throw new Error('pure-engine migration correction anchor missing');
source = source.replace(before, after);
writeFileSync(generatedPath, source, 'utf8');
await import(`./.apply-phase-b-pure-engine.generated.mjs?run=${Date.now()}`);
