/**
 * DiscoveryDiagnosisValidator — the deterministic kernel gate that accepts or
 * rejects a diagnosis LM worker's proposed report.
 *
 * Roadmap D5, §8. PURE: no SQLite, no LM, no I/O. The diagnosis service calls
 * this after the worker submits; the result decides whether the row is marked
 * `accepted_by_kernel` (the durable advisory answer) or `rejected_by_kernel`
 * (durable audit evidence of an invalid attempt). A rejected report NEVER
 * changes the D4 outcome (invariant I5).
 *
 * The validator enforces, in order:
 *   1. target binding — exact certificate id/hash/input_hash/decision match;
 *   2. forbidden fields — none of the authority-shaped field names present;
 *   3. reason coverage — every certificate reason_code covered by a cause;
 *      no cause cites an unknown reason code;
 *   4. condition coverage — every failed_condition_id exists in the case and is
 *      `failed` (citing a passed condition as a root cause is rejected);
 *   5. source refs — every cited ref is in the case allowlist; none empty;
 *   6. internal references — resolves_cause_ids all point to existing cause_ids;
 *      all ids unique;
 *   7. outcome consistency — GO has no blocking cause; clarify has ≥1 cause;
 *      reject has ≥1 blocking cause;
 *   8. confidence — finite, in [0, 1].
 */
import {
  DIAGNOSIS_ACTIONS,
  DIAGNOSIS_CAUSE_CATEGORIES,
  DIAGNOSIS_SEVERITIES,
  FORBIDDEN_DIAGNOSIS_FIELDS,
} from './discovery-diagnosis-report.js';
import type { DiscoveryDiagnosisCase } from './discovery-diagnosis-case.js';

export interface DiagnosisValidation {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Validate a proposed diagnosis report against the immutable case. Returns the
 * full error list (the service persists it on rejection so the failure is
 * durable and observable).
 */
export function validateDiagnosisReport(
  payload: unknown,
  caseData: DiscoveryDiagnosisCase,
): DiagnosisValidation {
  const errors: string[] = [];

  if (!isRecord(payload)) {
    return { valid: false, errors: ['diagnosis payload must be a JSON object'] };
  }

  // 0. Forbidden fields — checked first so an authority-shaped payload never
  // reaches the structural checks.
  for (const forbidden of FORBIDDEN_DIAGNOSIS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, forbidden)) {
      errors.push(`diagnosis payload must not contain forbidden field '${forbidden}'`);
    }
  }

  // 1. Target binding — exact certificate id/hash/input_hash/decision match.
  const target = payload.target;
  if (!isRecord(target)) {
    errors.push('field \'target\' must be an object');
  } else {
    const cert = caseData.certificate;
    const checks: Array<[string, unknown, unknown]> = [
      ['target.certificate_id', target.certificate_id, cert.id],
      ['target.certificate_hash', target.certificate_hash, cert.hash],
      ['target.settlement_input_hash', target.settlement_input_hash, cert.settlement_input_hash],
      ['target.decision', target.decision, cert.decision],
    ];
    for (const [field, actual, expected] of checks) {
      if (actual !== expected) {
        errors.push(`field '${field}' must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }
  }

  // 2. schema_version.
  if (payload.schema_version !== 'saga3.discovery-diagnosis.v1') {
    errors.push(`field 'schema_version' must be 'saga3.discovery-diagnosis.v1', got ${JSON.stringify(payload.schema_version)}`);
  }

  // 3. executive_summary non-empty string.
  if (typeof payload.executive_summary !== 'string' || payload.executive_summary.trim() === '') {
    errors.push('field \'executive_summary\' must be a non-empty string');
  }

  // 4. confidence finite in [0, 1].
  if (typeof payload.confidence !== 'number'
      || !Number.isFinite(payload.confidence)
      || payload.confidence < 0
      || payload.confidence > 1) {
    errors.push('field \'confidence\' must be a finite number in [0, 1]');
  }

  // 5. cause_analysis structural validation + collect ids.
  const causeIds = new Set<string>();
  const causeIdObjects: { cause_id: string; reason_codes: string[]; failed_condition_ids: string[] }[] = [];
  const causes = payload.cause_analysis;
  if (!Array.isArray(causes)) {
    errors.push('field \'cause_analysis\' must be an array');
  } else {
    causes.forEach((cause, index) => {
      if (!isRecord(cause)) {
        errors.push(`cause_analysis[${index}] must be an object`);
        return;
      }
      const cid = cause.cause_id;
      if (typeof cid !== 'string' || cid.trim() === '') {
        errors.push(`cause_analysis[${index}].cause_id must be a non-empty string`);
      } else if (causeIds.has(cid)) {
        errors.push(`cause_analysis[${index}].cause_id '${cid}' is a duplicate`);
      } else {
        causeIds.add(cid);
        causeIdObjects.push({
          cause_id: cid,
          reason_codes: isStringArray(cause.reason_codes) ? cause.reason_codes : [],
          failed_condition_ids: isStringArray(cause.failed_condition_ids) ? cause.failed_condition_ids : [],
        });
      }
      if (typeof cause.category !== 'string'
          || !DIAGNOSIS_CAUSE_CATEGORIES.includes(cause.category as never)) {
        errors.push(`cause_analysis[${index}].category must be one of [${DIAGNOSIS_CAUSE_CATEGORIES.join(', ')}]`);
      }
      if (typeof cause.description !== 'string' || cause.description.trim() === '') {
        errors.push(`cause_analysis[${index}].description must be a non-empty string`);
      }
      if (typeof cause.severity !== 'string'
          || !DIAGNOSIS_SEVERITIES.includes(cause.severity as never)) {
        errors.push(`cause_analysis[${index}].severity must be one of [${DIAGNOSIS_SEVERITIES.join(', ')}]`);
      }
      if (!isStringArray(cause.reason_codes)) {
        errors.push(`cause_analysis[${index}].reason_codes must be an array of strings`);
      }
      if (!isStringArray(cause.failed_condition_ids)) {
        errors.push(`cause_analysis[${index}].failed_condition_ids must be an array of strings`);
      }
      if (!isStringArray(cause.source_refs)) {
        errors.push(`cause_analysis[${index}].source_refs must be an array of strings`);
      } else if (cause.source_refs.length === 0) {
        errors.push(`cause_analysis[${index}].source_refs must cite at least one source`);
      }
    });
  }

  // 6. information_requests structural + internal refs + source refs.
  const seenRequestIds = new Set<string>();
  const requests = payload.information_requests;
  if (!Array.isArray(requests)) {
    errors.push('field \'information_requests\' must be an array');
  } else {
    requests.forEach((req, index) => {
      if (!isRecord(req)) {
        errors.push(`information_requests[${index}] must be an object`);
        return;
      }
      if (typeof req.request_id !== 'string' || req.request_id.trim() === '') {
        errors.push(`information_requests[${index}].request_id must be a non-empty string`);
      } else if (seenRequestIds.has(req.request_id)) {
        errors.push(`information_requests[${index}].request_id '${req.request_id}' is a duplicate`);
      } else {
        seenRequestIds.add(req.request_id);
      }
      if (typeof req.question !== 'string' || req.question.trim() === '') {
        errors.push(`information_requests[${index}].question must be a non-empty string`);
      }
      if (!isStringArray(req.resolves_cause_ids)) {
        errors.push(`information_requests[${index}].resolves_cause_ids must be an array of strings`);
      }
      if (!isStringArray(req.source_refs)) {
        errors.push(`information_requests[${index}].source_refs must be an array of strings`);
      } else if (req.source_refs.length === 0) {
        errors.push(`information_requests[${index}].source_refs must cite at least one source`);
      }
    });
  }

  // 7. recommended_actions structural + action enum + internal refs + source refs.
  const seenActionIds = new Set<string>();
  const actions = payload.recommended_actions;
  if (!Array.isArray(actions)) {
    errors.push('field \'recommended_actions\' must be an array');
  } else {
    actions.forEach((act, index) => {
      if (!isRecord(act)) {
        errors.push(`recommended_actions[${index}] must be an object`);
        return;
      }
      if (typeof act.action_id !== 'string' || act.action_id.trim() === '') {
        errors.push(`recommended_actions[${index}].action_id must be a non-empty string`);
      } else if (seenActionIds.has(act.action_id)) {
        errors.push(`recommended_actions[${index}].action_id '${act.action_id}' is a duplicate`);
      } else {
        seenActionIds.add(act.action_id);
      }
      if (typeof act.action !== 'string'
          || !DIAGNOSIS_ACTIONS.includes(act.action as never)) {
        errors.push(`recommended_actions[${index}].action must be one of [${DIAGNOSIS_ACTIONS.join(', ')}]`);
      }
      if (typeof act.description !== 'string' || act.description.trim() === '') {
        errors.push(`recommended_actions[${index}].description must be a non-empty string`);
      }
      if (!isStringArray(act.resolves_cause_ids)) {
        errors.push(`recommended_actions[${index}].resolves_cause_ids must be an array of strings`);
      }
      if (!isStringArray(act.source_refs)) {
        errors.push(`recommended_actions[${index}].source_refs must be an array of strings`);
      } else if (act.source_refs.length === 0) {
        errors.push(`recommended_actions[${index}].source_refs must cite at least one source`);
      }
    });
  }

  // 8. residual_risks structural + source refs.
  const risks = payload.residual_risks;
  if (!Array.isArray(risks)) {
    errors.push('field \'residual_risks\' must be an array');
  } else {
    risks.forEach((risk, index) => {
      if (!isRecord(risk)) {
        errors.push(`residual_risks[${index}] must be an object`);
        return;
      }
      if (typeof risk.risk !== 'string' || risk.risk.trim() === '') {
        errors.push(`residual_risks[${index}].risk must be a non-empty string`);
      }
      if (!isStringArray(risk.source_refs)) {
        errors.push(`residual_risks[${index}].source_refs must be an array of strings`);
      } else if (risk.source_refs.length === 0) {
        errors.push(`residual_risks[${index}].source_refs must cite at least one source`);
      }
    });
  }

  // ---- Semantic checks (only meaningful once structure is well-formed) ----

  const allowed = new Set(caseData.allowed_source_refs);
  const failedConditions = new Map(
    caseData.policy_conditions.filter(c => c.result === 'failed').map(c => [c.condition_id, c]),
  );
  const allConditionIds = new Set(caseData.policy_conditions.map(c => c.condition_id));
  const certReasonCodes = new Set<string>(caseData.certificate.reason_codes);

  // 9. Reason coverage. §7 requires every certificate reason_code to be covered
  //    by at least one cause for CLARIFY and REJECT (those decisions are
  //    negative/explanatory — the diagnosis must explain each reason the policy
  //    emitted). For GO the certificate carries GO_READY_AND_GROUNDED and the
  //    diagnosis may legitimately have empty causes (it explains why everything
  //    is fine via residual risks + proceed_with_monitoring), so GO reason
  //    codes are NOT required to be covered. In ALL decisions a cause must not
  //    cite a reason_code the certificate does not carry (no invented codes).
  const coveredReasonCodes = new Set<string>();
  for (const c of causeIdObjects) {
    for (const code of c.reason_codes) {
      if (!certReasonCodes.has(code)) {
        errors.push(`cause '${c.cause_id}' cites reason code '${code}' not carried by the certificate`);
      } else {
        coveredReasonCodes.add(code);
      }
    }
  }
  const decisionForCoverage = caseData.certificate.decision;
  if (decisionForCoverage === 'clarify' || decisionForCoverage === 'reject') {
    for (const code of caseData.certificate.reason_codes) {
      if (!coveredReasonCodes.has(code)) {
        errors.push(`certificate reason code '${code}' is not covered by any cause_analysis`);
      }
    }
  }

  // 10. Condition coverage: every failed_condition_id must exist in the case and
  //     be `failed`. Citing a passed/not_applicable condition is rejected — the
  //     diagnosis may not root a cause in a predicate the policy already cleared.
  for (const c of causeIdObjects) {
    for (const condId of c.failed_condition_ids) {
      if (!allConditionIds.has(condId)) {
        errors.push(`cause '${c.cause_id}' cites unknown condition '${condId}'`);
      } else if (!failedConditions.has(condId)) {
        errors.push(`cause '${c.cause_id}' cites condition '${condId}' which is not 'failed' (passed/NA conditions cannot be a root cause)`);
      }
    }
  }

  // 11. Source refs: every cited ref must be in the case allowlist (catches
  //     invented evidence). Empty-array checks already ran above.
  const checkRefs = (refs: unknown, label: string): void => {
    if (!isStringArray(refs)) return;
    for (const ref of refs) {
      if (ref.trim() === '') {
        errors.push(`${label} cites an empty source ref`);
      } else if (!allowed.has(ref)) {
        errors.push(`${label} cites an unresolved source ref '${ref}'`);
      }
    }
  };
  if (Array.isArray(causes)) {
    causes.forEach((c, i) => isRecord(c) && checkRefs(c.source_refs, `cause_analysis[${i}].source_refs`));
  }
  if (Array.isArray(requests)) {
    requests.forEach((r, i) => isRecord(r) && checkRefs(r.source_refs, `information_requests[${i}].source_refs`));
  }
  if (Array.isArray(actions)) {
    actions.forEach((a, i) => isRecord(a) && checkRefs(a.source_refs, `recommended_actions[${i}].source_refs`));
  }
  if (Array.isArray(risks)) {
    risks.forEach((r, i) => isRecord(r) && checkRefs(r.source_refs, `residual_risks[${i}].source_refs`));
  }

  // 12. Internal references: every resolves_cause_ids must point to an existing
  //     cause_id.
  const checkCauseRefs = (refs: unknown, label: string): void => {
    if (!isStringArray(refs)) return;
    for (const id of refs) {
      if (!causeIds.has(id)) {
        errors.push(`${label} resolves_cause_ids references unknown cause '${id}'`);
      }
    }
  };
  if (Array.isArray(requests)) {
    requests.forEach((r, i) => isRecord(r) && checkCauseRefs(r.resolves_cause_ids, `information_requests[${i}]`));
  }
  if (Array.isArray(actions)) {
    actions.forEach((a, i) => isRecord(a) && checkCauseRefs(a.resolves_cause_ids, `recommended_actions[${i}]`));
  }

  // 13. Outcome consistency (§7).
  const decision = caseData.certificate.decision;
  if (decision === 'go') {
    // GO diagnosis must not create blocking causes (a blocking cause would
    // argue the settlement was wrong — I1).
    if (Array.isArray(causes)) {
      causes.forEach((c, i) => {
        if (isRecord(c) && c.severity === 'blocking') {
          errors.push(`decision is 'go' but cause_analysis[${i}] has severity 'blocking' (GO diagnosis must not create blocking causes)`);
        }
      });
    }
  } else if (decision === 'clarify') {
    // CLARIFY must have at least one cause (§7).
    if (!Array.isArray(causes) || causes.length === 0) {
      errors.push('decision is \'clarify\' but cause_analysis is empty');
    }
  } else if (decision === 'reject') {
    // REJECT must have at least one blocking cause (§7).
    const hasBlocking = Array.isArray(causes) && causes.some(c => isRecord(c) && c.severity === 'blocking');
    if (!hasBlocking) {
      errors.push('decision is \'reject\' but no cause has severity \'blocking\'');
    }
  }

  return { valid: errors.length === 0, errors };
}
