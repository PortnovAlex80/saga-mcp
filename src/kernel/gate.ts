import type Database from 'better-sqlite3';
import { appendEventInTx } from '../events.js';
import { putMaterial, requireMaterial } from '../materials.js';
import type { Item } from './node-types.js';

// M3 quality loop. The ADR-053 rule as data:
//   accepted material = a sealed DESK REVISION (content-addressed manifest of
//   member digests), never "the latest execution output". Members accumulate
//   across executions and repairs; the revision identity depends only on the
//   member digest SET — which execution produced what is provenance.

export type CheckOp =
  | 'nonempty'
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'json_array'
  /** Допускной: КАЖДЫЙ материал стола обязан быть JSON-массивом. */
  | 'each_json_array'
  /** На столе лежат готовые файлы ({path, content}) — не менее min_count. */
  | 'files'
  | 'command_ok';

export interface GateCheck {
  op: CheckOp;
  /** Item field the check reads (default 'text'). */
  field?: string;
  value?: string;
  pattern?: string;
  /** json_array: minimum element count. */
  min_count?: number;
}

export interface GateParameters {
  checks: GateCheck[];
  /** Node that re-executes on repair_required (default: first inbound). */
  repair_target?: string;
  /** repair_required verdicts allowed before the gate goes human_required. */
  max_repairs?: number;
  /** Узел стола-поставщика, которому уходит претензия, когда ремонт на СВОЁМ
   *  уровне исчерпан. «Задача не режется» — претензия к плану, а не к
   *  рабочему, и звать человека, пока есть адресат выше, преждевременно. */
  escalate_to?: string;
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
    } else if (check.op === 'json_array') {
      // Structural validation for planner outputs: the field must BE a JSON
      // array with at least min_count elements. Malformed JSON fails the gate
      // with a typed reason that travels back into the planner's repair.
      const min = typeof check.min_count === 'number' ? check.min_count : 1;
      let ok = false;
      let reason = `json_array:${field} — not a JSON array of ≥${min}`;
      for (const item of items) {
        try {
          const parsed = JSON.parse(fieldValue(item, field)) as unknown;
          if (Array.isArray(parsed) && parsed.length >= min) {
            ok = true;
            break;
          }
          reason = `json_array:${field} — array has ${Array.isArray(parsed) ? parsed.length : 'non-array'} elements, need ≥${min}`;
        } catch {
          reason = `json_array:${field} — not valid JSON`;
        }
      }
      if (!ok) reasons.push(reason);
    } else if (check.op === 'each_json_array') {
      // Допускной критерий веера: если ниже по конвейеру КАЖДЫЙ материал
      // разбирается как JSON, то один негодный член — это не «плохой стол»,
      // а негодный член. Он вытесняется со стола со своей причиной, и работа
      // соседей не пропадает. Пойман живьём: один воркер вернул служебный
      // поток вместо ответа — гейт с «достаточно одного» это пропустил, и
      // разбор ниже уронил весь прогон.
      const min = typeof check.min_count === 'number' ? check.min_count : 1;
      let bad: string | undefined;
      for (const item of items) {
        const raw = fieldValue(item, field);
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed) || parsed.length < min) {
            bad = `не JSON-массив из ≥${min}`;
            break;
          }
        } catch {
          bad = `не разбирается как JSON: «${raw.slice(0, 60)}…»`;
          break;
        }
      }
      ok = bad === undefined;
      if (!ok) reasons.push(`each_json_array:${field} — ${bad}`);
    } else if (check.op === 'files') {
      // Файл считается сданным, когда у него есть и имя, и непустое тело:
      // пустышка с правильным путём — это заглушка, а не работа.
      const need = check.min_count ?? 1;
      const files = items.filter(
        (item) => String(item.json.path ?? '').trim().length > 0
          && String(item.json.content ?? '').trim().length > 0
      );
      ok = files.length >= need;
      if (!ok) reasons.push(`files — сдано файлов: ${files.length}, требуется не меньше ${need}`);
    } else if (check.op === 'command_ok') {
      // Приёмка «программа запускается»: исход команды, а не обещание модели.
      // Вывод команды попадает В ПРИЧИНУ отказа, поэтому доработка получает
      // текст ошибки компилятора/теста, а не «что-то пошло не так».
      const runs = items.filter((item) => item.json[field] !== undefined || item.json.exit_code !== undefined);
      ok = runs.length > 0 && runs.every((item) => item.json[field] === true);
      if (!ok) {
        const failed = runs.find((item) => item.json[field] !== true);
        const output = String(failed?.json.output ?? '').trim().slice(-800);
        reasons.push(
          runs.length === 0
            ? 'command_ok — команда не выполнялась, исход неизвестен'
            : `command_ok — «${String(failed?.json.command ?? 'команда')}» завершилась с кодом ` +
              `${String(failed?.json.exit_code ?? '?')}:\n${output}`
        );
      }
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

/** One member of the desk under judgement: exactly one submitted material. */
export interface DeskMember {
  node: string;
  digest: string;
  items: Item[];
}

export interface DeskOutcome extends GateVerdict {
  /** Members that violated an ADMISSION criterion and leave the desk. */
  tainted: Array<{ node: string; digest: string; reason: string }>;
  /** Members that survive and form the sealed revision. */
  survivors: DeskMember[];
}

/** Desk-level evaluation, member by member.
 *
 *  Positive criteria (`nonempty`, `contains`, `regex`, `json_array`) are
 *  ACCEPTANCE criteria: satisfied when SOME surviving member satisfies them —
 *  desks accumulate, so a later repair may complete what an earlier attempt
 *  started (ADR-053).
 *
 *  `not_contains` is an ADMISSION criterion: it must hold for EVERY member.
 *  Without superseding, an accumulating desk could never be repaired — the
 *  offending material would sit there forever and burn the whole repair budget.
 *  So a violating member is dropped from the desk with an explicit, logged
 *  reason, and the repair judges only what remains. */
export function evaluateDesk(checks: GateCheck[], members: DeskMember[]): DeskOutcome {
  const isAdmission = (check: GateCheck): boolean =>
    check.op === 'not_contains' || check.op === 'each_json_array';
  const admission = checks.filter(isAdmission);
  const acceptance = checks.filter((check) => !isAdmission(check));

  const tainted: DeskOutcome['tainted'] = [];
  const survivors: DeskMember[] = [];
  for (const member of members) {
    // Причина берётся у САМОГО критерия: оператор должен прочитать, чем
    // именно материал не подошёл, а не «не подошёл».
    let failure: string | undefined;
    for (const check of admission) {
      const verdict = evaluateChecks([check], member.items);
      if (verdict.verdict !== 'accepted') {
        failure = verdict.reasons[0] ?? `${check.op} — материал не допущен`;
        break;
      }
    }
    if (failure) {
      tainted.push({
        node: member.node,
        digest: member.digest,
        reason: `${failure} — материал вытеснен со стола`,
      });
    } else {
      survivors.push(member);
    }
  }

  const items = survivors.flatMap((member) => member.items);
  const outcome = evaluateChecks(acceptance, items);
  const reasons = [...tainted.map((entry) => entry.reason), ...outcome.reasons];
  return {
    verdict: reasons.length === 0 ? 'accepted' : 'repair_required',
    reasons,
    tainted,
    survivors,
  };
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

/** Splits the accumulated desk into judgeable members (one per material). */
export function deskMembers(
  db: Database.Database,
  entries: RevisionMembers[]
): DeskMember[] {
  return entries.flatMap((entry) =>
    entry.digests.map((digest) => ({
      node: entry.node,
      digest,
      items: readDeskItems(db, [digest]),
    }))
  );
}
