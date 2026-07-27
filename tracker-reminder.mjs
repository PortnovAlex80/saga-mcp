#!/usr/bin/env node
// Generic Process Module PostToolUse hook.
//
// The runner passes the exact machine-provisioned tracker path through
// SAGA_PROCESS_TRACKER_PATH. The hook deliberately never scans docs/: scanning
// can select another epic/task and inject a false next step into a weak model.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

try {
  // Consume the hook event even though tracker selection is environment-bound.
  readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}

const trackerPath = process.env.SAGA_PROCESS_TRACKER_PATH || '';
if (!trackerPath || !path.isAbsolute(trackerPath) || !existsSync(trackerPath)) {
  process.stdout.write('{}');
  process.exit(0);
}

let trackerContent;
try {
  trackerContent = readFileSync(trackerPath, 'utf8');
} catch {
  process.stdout.write('{}');
  process.exit(0);
}

const explicitStep = trackerContent.match(/## Current Step:\s*(.+)/i)?.[1]?.trim()
  ?? trackerContent.match(/-\s*current_step:\s*`?([^`\r\n]+)`?/i)?.[1]?.trim()
  ?? 'unknown';
const doneSteps = (trackerContent.match(/- \[x\].+/gi) || [])
  .map(line => line.replace(/- \[x\]\s*/i, '').slice(0, 100));
const pendingSteps = (trackerContent.match(/- \[ \].+/g) || [])
  .map(line => line.replace(/- \[ \]\s*/, '').slice(0, 100));

const checklistPaths = (process.env.SAGA_PROCESS_CHECKLIST_PATHS || '')
  .split(path.delimiter)
  .filter(Boolean);
const checklistHint = checklistPaths.length > 0
  ? `\nChecklists: ${checklistPaths.join(', ')}`
  : '';

const reminder = `PROCESS TRACKER REMINDER
Exact file: ${trackerPath}
Current step: ${explicitStep}
Completed: ${doneSteps.length > 0 ? doneSteps.join(' | ') : 'none'}
Next unchecked step: ${pendingSteps.length > 0 ? pendingSteps[0] : 'none — verify completion state'}
${checklistHint}
ACTION: If the last tool completed a step, update this exact tracker now. Read the relevant checklist before every consequential MCP write.`;

process.stdout.write(JSON.stringify({ additionalContext: reminder }));
