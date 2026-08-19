#!/usr/bin/env node
// Hermetic opencode stub for the provider-retry shim tests (no network, no
// ~/.claude, no real opencode/GLM). Behavior is driven entirely by env:
//
//   STUB_PLAN  — JSON array of steps: { stdout?, stderr?, code?, sleepMs? }.
//                Invocation N (1-based) executes plan[min(N-1, len-1)].
//   STUB_STATE — path to a file holding the invocation counter. The test
//                asserts the exact number of shim attempts through it.
//
// The shim spawns this file via SAGA_PROXY_OPENCODE_PATH (the shim recognizes
// a *.mjs/*.js override and prepends the node executable).
/* eslint-disable no-console */

import { readFileSync, writeFileSync } from 'node:fs';

const plan = JSON.parse(process.env.STUB_PLAN || '[]');
const statePath = process.env.STUB_STATE;

let invocations = 0;
try { invocations = Number(readFileSync(statePath, 'utf8')) || 0; } catch { /* first call */ }
invocations += 1;
try { writeFileSync(statePath, String(invocations)); } catch { /* state is best-effort for the test */ }

const step = plan[Math.min(invocations - 1, plan.length - 1)] || { code: 0 };

if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));

// Flush writes through the pipe callback before exiting (POSIX pipe writes
// are async; process.exit could truncate the output the test compares).
const write = (stream, s) => new Promise((r) => stream.write(s, () => r()));
if (step.stdout) await write(process.stdout, step.stdout);
if (step.stderr) await write(process.stderr, step.stderr);
process.exit(step.code ?? 0);
