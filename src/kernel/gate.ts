import type Database from 'better-sqlite3';
import { appendEventInTx } from '../events.js';
import { putMaterial, requireMaterial } from '../materials.js';
import type { Item } from './node-types.js';

// M3 quality loop. The ADR-053 rule as data:
//   accepted material = a sealed DESK REVISION (content-addressed manifest of
//   member digests), never "the latest execution output". Members accumulate
//   across executions and repairs; the revision identity depends only on the
//   member digest SET — which execution produced what is provenance.

export type CheckOp = 'nonempty' | 'contains' | 'regex' | 'not_contains';

export interface GateCheck {
  op: CheckOp;
  /** Item field the check reads (default 'text'). */
  field?: string;
  value?: string;
  pattern?: string;
}

export interface GateParameters {
  checks: GateCheck[];
  /** Node that re-executes on repair_required (default: first inbound). */
  repair_target?: string;
  /** repair_required verdicts allowed before the gate goes human_required. */
  max_repairs?: number;
  title?: string;
}

export interface GateVerdict {
  verdict: 'accepted' | 'repair_required' | 'human_required';
  reasons: string[];
}

function fieldValue(item: Item, field: string): string {
  const value = item.json[field];
  return value === undefined || value === null ? '' : String(value);
}

/** Deterministic check evaluation over the flattened desk items. */
export function evaluateChecks(checks: GateCheck[], items: Item[]): GateVerdict {
  const reasons: string[] = [];
  for (const check of checks) {
    const field = check.field ?? 'text';
    let ok = false;
    if (check.op === 'nonempty') {
      ok = items.some((item) => fieldValue(item, field).trim().length > 0);
      if (!ok) reasons.push(`nonempty:${field} — no non-empty value on the desk`);
    } else if (check.op === 'contains') {
      ok = items.some((item) => fieldValue(item, field).includes(String(check.value ?? '')));
      if (!ok) reasons.push(`contains:${field} — '${check.value}' not found`);
    } else if (check.op === 'not_contains') {
      // Negative criterion: forbidden content (e.g. unreadable mojibake U+FFFD)
      // fails acceptance with a typed reason instead of sneaking through.
      ok = !items.some((item) => fieldValue(item, field).includes(String(check.value ?? '')));
      if (!ok) reasons.push(`not_contains:${field} — forbidden value present`);
    } else if (check.op === 'regex') {
      let re: RegExp;
      try {
        re = new RegExp(String(check.pattern ?? ''));
      } catch {
        reasons.push(`regex — invalid pattern '${check.pattern}'`);
        continue;
      }
      ok = items.some((item) => re.test(fieldValue(item, field)));
      if (!ok) reasons.push(`regex:${field} — /${check.pattern}/ not matched`);
    } else {
      reasons.push(`unknown check op '${(check as GateCheck).op}'`);
    }
  }
  return reasons.length === 0
    ? { verdict: 'accepted', reasons: [] }
    : { verdict: 'repair_required', reasons };
}

export interface RevisionMembers {
  node: string;
  digests: string[];
}

/** Canonical revision manifest. Sorting makes identity partition-invariant:
 *  the same member digest set yields the same revision digest no matter which
 *  execution produced which member, or in what order they landed. */
export function revisionManifest(members: RevisionMembers[]): string {
  const canonical = members
    .map((m) => ({ node: m.node, digests: [...m.digests].sort() }))
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  return JSON.stringify({ revision: 1, members: canonical });
}

/** Seals the desk revision: manifest stored content-addressed (schema_ref
 *  'desk_revision'), plus the audit events — one transaction. */
export function sealRevision(
  db: Database.Database,
  runId: string,
  gateNode: string,
  members: RevisionMembers[],
  now = new Date()
): { digest: string; members: RevisionMembers[] } {
  const manifest = revisionManifest(members);
  return db.transaction(() => {
    const { digest } = putMaterial(db, 'desk_revision', manifest);
    appendEventInTx(db, runId, 'revision.sealed', {
      node_id: gateNode,
      revision_digest: digest,
      members,
      ts: now.toISOString(),
    });
    return { digest, members };
  }).immediate();
}

/** Reads the accumulated desk items of one upstream node (all completed
 *  materials in event order — accumulation across executions, not 'latest'). */
export function readDeskItems(
  db: Database.Database,
  digests: string[]
): Item[] {
  return digests.flatMap((digest) => JSON.parse(requireMaterial(db, digest).content) as Item[]);
}
