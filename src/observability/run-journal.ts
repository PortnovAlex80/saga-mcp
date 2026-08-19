// src/observability/run-journal.ts
//
// STAGE-10 TASK 1 — the correlated run journal.
//
// FORMAT DECISION (brief requirement: justify): append-only JSONL.
//   - one JSON object per line, single append syscall per event;
//   - a crash mid-write can truncate only the TAIL of the last line —
//     a reader skips unparseable trailing lines and loses at most one event;
//   - no locks, no schema, no migration: a projection, never an authority;
//   - greppable by every correlation key without tooling.
//
// THE LOAD-BEARING CONSTRAINT (STAGE-10 brief): observation only.
//   A log is a projection. It may never become an authority, a decision
//   input, or a recovery trigger. NOTHING in the factory may read the
//   journal back. This module therefore exports exactly ONE function —
//   journalEvent — and no read/open/parse API exists. The architecture
//   ratchet (tests/architecture/run-journal-observation-only.test.mjs)
//   pins the frozen module surface, the frozen importer set, and the
//   absence of any read-back path in compiled factory code. The only
//   sanctioned consumer is tools/capture-run-snapshot.mjs (post-mortem,
//   outside the factory runtime).
//
// FAILURE DISCIPLINE: observation can never break the factory. Every
// failure — unwritable path, full disk, serialization error — is swallowed.
// A missing journal is a lost projection, never a lost production fact:
// every journalled fact is already durable in its authority table
// (worker_executions, factory_gate_runs, factory_external_effect_actions,
// transition obligations, lifecycle run state).

import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Correlation keys required on every record where applicable (brief §Task 1). */
export interface RunJournalCorrelation {
  run_id?: string;
  epic_id?: number | string;
  workplace_ref?: string;
  execution_id?: number | string;
  node_id?: string;
  candidate_set_ref?: string;
}

export interface RunJournalEvent extends RunJournalCorrelation {
  ts: string;
  kind: string;
  data?: Record<string, unknown>;
}

function resolveJournalPath(): string | null {
  const override = process.env.SAGA_RUN_JOURNAL;
  if (override !== undefined) {
    return override === 'off' ? null : override;
  }
  const dbPath = process.env.DB_PATH;
  if (!dbPath || dbPath === ':memory:') return null;
  return join(dirname(dbPath), 'factory-run-journal.jsonl');
}

/**
 * Append one observation record. Never throws. Correlation keys that are
 * present are copied verbatim; `kind` names the event class; `data` carries
 * the site-specific payload (argv, digests, verdicts, classifications...).
 */
export function journalEvent(
  kind: string,
  correlation: RunJournalCorrelation,
  data?: Record<string, unknown>,
): void {
  try {
    const path = resolveJournalPath();
    if (!path) return;
    const event: Record<string, unknown> = { ts: new Date().toISOString(), kind };
    for (const key of ['run_id', 'epic_id', 'workplace_ref', 'execution_id', 'node_id', 'candidate_set_ref'] as const) {
      const value = correlation[key];
      if (value !== undefined && value !== null && `${value}` !== '') {
        event[key] = value;
      }
    }
    if (data !== undefined) event.data = data;
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // Observation must not break production. Intentionally swallowed.
  }
}
