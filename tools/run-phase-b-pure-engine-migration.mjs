#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const sourcePath = 'tools/apply-phase-b-pure-engine.mjs';
const generatedPath = 'tools/.apply-phase-b-pure-engine.generated.mjs';
let source = readFileSync(sourcePath, 'utf8');

const retryBefore = "replaceExact(orchestrate, `          resetHealRetriesForEpic(epicId);`, `          resetHealRetriesForEpic(epicId, state);`);";
const retryAfter = "replaceExact(orchestrate, `          resetHealRetriesForEpic(epicId);`, `          resetHealRetriesForEpic(epicId, state);`, 2);";
if (!source.includes(retryBefore)) throw new Error('pure-engine retry correction anchor missing');
source = source.replace(retryBefore, retryAfter);

const finalGuard = "const finalSource = read(orchestrate);";
if (!source.includes(finalGuard)) throw new Error('pure-engine final guard anchor missing');
source = source.replace(
  finalGuard,
  "replaceExact(orchestrate, `const RATE_LIMIT_LOG_TAIL_BYTES = 8192;  // scan last 8KB of JSONL for 429\\n`, '');\\n\\n" + finalGuard,
);

writeFileSync(generatedPath, source, 'utf8');
await import(`./.apply-phase-b-pure-engine.generated.mjs?run=${Date.now()}`);
