#!/usr/bin/env node
/**
 * KI-2 metric: wasted turns on toolset hallucination (plan item 17).
 *
 * Counts per-execution wasted tool calls: the number of tool_use entries
 * BEFORE the first productive action (Write|Edit|artifact_create), plus
 * Edit/Write probes that error with "File does not exist", plus a regex
 * flag for the hallucination pattern in thinking/text.
 *
 * Read-only: parses worker JSONL logs (worker_executions.log_path) +
 * command_receipts from the DB. No writes, no process spawning.
 *
 *   node scripts/wasted-turns-metric.mjs <db-path> [--project <id>]
 */
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';

const dbPath = process.argv[2];
if (!dbPath || !existsSync(dbPath)) {
  console.error('usage: node scripts/wasted-turns-metric.mjs <db-path> [--project <id>]');
  process.exit(2);
}
const projectFlag = process.argv.indexOf('--project');
const projectId = projectFlag > 0 ? Number(process.argv[projectFlag + 1]) : null;

const db = new Database(dbPath, { readonly: true });
const HALLUCINATION_RE = /(do(n't| not) have).{0,40}Write|no Write tool|only have \w+ tool|don't see.{0,30}(Write|function definitions?)/i;
const PRODUCTIVE = /^(Write|Edit|mcp__saga__artifact_create|mcp__saga__product_submit)/;
const PROBE_ERROR = /File does not exist|no such file|ENOENT/;

const execs = db.prepare(`
  SELECT we.execution_id, we.log_path, we.project_id, we.task_id,
         we.started_at, we.finished_at
    FROM worker_executions we
   ${projectId ? 'WHERE we.project_id = ?' : ''}
   ORDER BY we.started_at`).all(...(projectId ? [projectId] : []));

let flagged = 0, totalWasted = 0, totalProbes = 0;
const rows = [];
for (const exec of execs) {
  if (!exec.log_path || !existsSync(exec.log_path)) continue;
  let content;
  try { content = readFileSync(exec.log_path, 'utf8'); } catch { continue; }
  const lines = content.split('\n').filter(l => l.trim());
  let toolUses = 0, wasted = 0, probes = 0, first = -1, hallucinated = false;
  for (let i = 0; i < lines.length; i++) {
    let entry; try { entry = JSON.parse(lines[i]); } catch { continue; }
    // tool_use blocks
    const msg = entry?.message ?? entry;
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        toolUses++;
        if (first < 0 && PRODUCTIVE.test(block.name)) first = toolUses;
        if (first < 0) wasted++;
      }
      if (block?.type === 'tool_result' && block?.is_error && PROBE_ERROR.test(String(block.content ?? ''))) {
        probes++;
      }
      if (block?.type === 'thinking' && HALLUCINATION_RE.test(String(block.thinking ?? ''))) {
        hallucinated = true;
      }
    }
    if (typeof msg?.text === 'string' && HALLUCINATION_RE.test(msg.text)) hallucinated = true;
  }
  if (toolUses > 0) {
    if (hallucinated) flagged++;
    totalWasted += wasted; totalProbes += probes;
    rows.push({
      exec: exec.execution_id.slice(0, 18),
      task: exec.task_id,
      toolUses, wastedBeforeProductive: wasted,
      fileProbes: probes, hallucination: hallucinated,
    });
  }
}
db.close();

rows.sort((a, b) => b.wastedBeforeProductive + b.fileProbes - (a.wastedBeforeProductive + a.fileProbes));
const top = rows.slice(0, 20);
console.log(`executions with tool_use: ${rows.length}`);
console.log(`hallucination-flagged:    ${flagged} (${rows.length ? Math.round(flagged / rows.length * 100) : 0}%)`);
console.log(`total wasted (pre-productive): ${totalWasted}`);
console.log(`total file-probe errors:       ${totalProbes}`);
console.log(`\nTop 20 by waste:`);
for (const r of top) {
  console.log(`  ${r.exec} task=${String(r.task).padEnd(5)} tools=${String(r.toolUses).padEnd(4)} wasted=${String(r.wastedBeforeProductive).padEnd(4)} probes=${String(r.fileProbes).padEnd(3)} hall=${r.hallucination}`);
}
