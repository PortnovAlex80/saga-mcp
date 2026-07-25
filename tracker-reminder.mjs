#!/usr/bin/env node
// PostToolUse hook: reads the worker's stage tracker and injects a reminder
// into the model's context via additionalContext. Runs after EVERY tool call.
//
// stdin: JSON { tool_name, tool_input, tool_result, cwd, ... }
// stdout: JSON { additionalContext: "..." } or {} (no reminder)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}

let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}

// Find the tracker file in the workspace — works for ANY stage (discovery,
// formalization, etc.) not just discovery.
const cwd = event.cwd || process.cwd();
const discoveryDir = join(cwd, 'docs', 'discovery');
const projectsDir = join(discoveryDir, 'projects');

// Find any project-*-stage.md tracker. With the per-epic workspace layout
// (docs/discovery/projects/<N>/project-N-discovery-stage.md) we recurse one
// level into projects/. Falls back to the legacy flat layout for back-compat.
let trackerPath = null;
let trackerContent = null;
try {
  const flatten = (dir) => {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const st = statSync(p);
        if (st.isDirectory()) out.push(...readdirSync(p).map(n => join(p, n)));
        else out.push(p);
      } catch {}
    }
    return out;
  };
  // Prefer projects/ subdir; fall back to flat discoveryDir for old epics.
  const candidates = existsSync(projectsDir) ? flatten(projectsDir) : flatten(discoveryDir);
  const match = candidates.find(f => f.match(/project-\d+-\w+-stage\.md$/));
  if (match) {
    trackerPath = match;
    trackerContent = readFileSync(trackerPath, 'utf8');
  }
} catch {
  // No tracker yet — that's fine for non-discovery tasks
}

if (!trackerContent) {
  process.stdout.write('{}');
  process.exit(0);
}

// Parse current step from tracker
const stepMatch = trackerContent.match(/## Current Step:\s*(.+)/);
const currentStep = stepMatch ? stepMatch[1].trim() : 'unknown';

// Parse which steps are done
const doneSteps = (trackerContent.match(/- \[x\].+/g) || []).map(s => s.replace(/- \[x\]\s*/, '').slice(0, 60));
const pendingSteps = (trackerContent.match(/- \[ \].+/g) || []).map(s => s.replace(/- \[ \]\s*/, '').slice(0, 60));

// Read the proposal-call template checklist if it exists
const checklistPath = join(discoveryDir, 'tools', 'proposal-checklist.md');
let checklistHint = '';
try {
  if (existsSync(checklistPath)) {
    checklistHint = '\n📋 Proposal checklist available at docs/discovery/tools/proposal-checklist.md — read it before submitting.';
  }
} catch {}

// Build the reminder
const reminder = `📊 STAGE TRACKER REMINDER
File: ${trackerPath}
Current Step: ${currentStep}
Completed: ${doneSteps.length > 0 ? doneSteps.join(' | ') : 'none'}
Next: ${pendingSteps.length > 0 ? pendingSteps[0] : 'all done — call worker_done'}
${checklistHint}
ACTION: Update the tracker (mark current step [x], set Current Step to next) if you haven't already.`;

process.stdout.write(JSON.stringify({ additionalContext: reminder }));
