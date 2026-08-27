/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/checkplan.mjs -
 * the installed CHECKPLAN and semantic gates of the WHAT-freeze kernel
 * desk and the settle desk (FRF-WP07; R15: the CheckPlan is
 * installed-manifest input evidence the kernel's gate guards require).
 *
 * THE PLAN IS DETERMINISTIC:
 *   - every check row is machine-checkable over content-addressed inputs
 *     except the freeze-drift disposition, which is OPERATOR-ONLY (the
 *     desk cannot observe the human drift decision; D12 vocabulary);
 *   - the declared rule table routes outcomes deterministically:
 *       exact-authority-ingestion fail  -> repair (re-carry the surfaces)
 *       set-equality fail (substitution)-> drift-detected -> human-wait
 *       no-folding fail (F-8)           -> drift-detected -> human-wait
 *       whole-digest fail               -> drift-detected -> human-wait
 *       universe not carried            -> indeterminate -> human-wait (D5)
 *       drift disposition operator-only -> human-wait (D12)
 *       all pass                        -> accepted (domain.frozen)
 *   - the evaluator never invents a verdict: it walks the DECLARED rows
 *     in order and returns the first match; no matching rule over an
 *     all-machine check set is a typed refusal (never a default).
 *
 * PURITY: pure functions over declared data. No I/O, no session.
 */

import { sha256OfCanonical } from './shared.mjs';

/* ------------------------------------------------------------------ */
/* The installed CheckPlan rows                                        */
/* ------------------------------------------------------------------ */

export const FREEZE_AUTHOR_GATE_ID = 'what-freeze.author';
export const FREEZE_FINAL_GATE_ID = 'what-freeze.final';
export const FREEZE_DRIFT_GATE_ID = 'what-freeze.drift-disposition';
export const SETTLE_FINAL_GATE_ID = 'what-freeze.settlement';

function checkRow(row) {
  const digest = sha256OfCanonical(row.content);
  return { checkId: row.checkId, gate: row.gate, evaluator: row.evaluator, contentRef: `sha256:${digest}`, digest };
}

/** The complete installed CheckPlan of the WHAT-freeze cell (content-addressed rows). */
export function whatFreezeCheckPlanRows() {
  return [
    checkRow({
      checkId: 'what-freeze.check.surfaces-carried',
      gate: FREEZE_AUTHOR_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'every accepted-authority surface class (case identity, source manifests, acceptance records, the six containers with member/branch ids+digests and revision pins, the trace set, the five disposition sections, the evidence bindings, the Development surface) was carried by the transition; fail-closed, the freezer never scans',
        inputProduct: 'frf-contracts.what-baseline-surfaces.v1',
        onFail: 'indeterminate (D5 human-input wait)',
      },
    }),
    checkRow({
      checkId: 'what-freeze.check.legacy-fold-refused',
      gate: FREEZE_AUTHOR_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'the folded legacy baseline shape (memberDigests/acceptedTraceDigest) is refused on sight (F-8 / ledger D-10)',
        inputProduct: 'frf-contracts.what-baseline.v1',
        onFail: 'repair',
      },
    }),
    checkRow({
      checkId: 'what-freeze.check.no-folding',
      gate: FREEZE_AUTHOR_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'the five disposition sections and the evidence-method bindings survive as distinct named sections exactly as accepted (folding that loses a named record is drift)',
        inputProduct: 'frf-contracts.what-baseline.v1',
        onFail: 'drift-detected (human-wait, D12)',
      },
    }),
    checkRow({
      checkId: 'what-freeze.check.exact-authority-ingestion',
      gate: FREEZE_AUTHOR_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'every frozen member/branch equals the accepted manifest id-for-id AND digest-for-digest; the trace set, source manifests, case identity, acceptance records and Development surface are pinned exactly (substitution is drift)',
        inputProduct: 'frf-contracts.what-baseline.v1',
        onFail: 'drift-detected (human-wait, D12)',
      },
    }),
    checkRow({
      checkId: 'what-freeze.check.wp03-validator',
      gate: FREEZE_FINAL_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'the whole-WHAT baseline seals via the FRF-WP03 typed validator (validateWhatBaseline) against the universe derived from the same carried surfaces: exact set equality, closed trace grammar, closure laws cr-04/cr-05, the epic-scope-equality law, the closed Development surface, one canonical whole-WHAT digest',
        inputProduct: 'frf-contracts.what-baseline.v1',
        onFail: 'route by the typed refusal code (the protocol table)',
      },
    }),
    checkRow({
      checkId: 'what-freeze.check.drift-disposition',
      gate: FREEZE_DRIFT_GATE_ID,
      evaluator: 'operator',
      content: {
        rule: 'the freeze-drift human decision: the machine carries the drift evidence but CANNOT observe the operator disposition (resume-upstream-repair or confirm-inconsistent); an automatic redrive is refused',
        inputProduct: 'frf-contracts.freeze-drift-decision.v1',
        wake: 'TypedWait:effect-uncertainty (D12), discharged only by the operator disposition receipt naming the exact drift evidence digest',
      },
    }),
    checkRow({
      checkId: 'what-freeze.check.settlement-authority-pins',
      gate: SETTLE_FINAL_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'settlement pins the exact frozen baseline artifact (ref + recomputed digest + whole-WHAT digest) and the exact accepted SRS revision; a forged or partially-substituted authority is drift',
        inputProduct: 'frf-contracts.solution-contract.v1',
        onFail: 'inconsistent (domain.inconsistent)',
      },
    }),
    checkRow({
      checkId: 'what-freeze.check.settlement-binding-resolution',
      gate: SETTLE_FINAL_GATE_ID,
      evaluator: 'machine',
      content: {
        rule: 'all twelve Development handoff kinds carry typed non-empty values resolving against the FROZEN baseline exact id sets per its own resolvesAgainst declaration (cr-02; the UC-FOREIGN kill)',
        inputProduct: 'frf-contracts.solution-contract.v1',
        onFail: 'inconsistent (FOREIGN_LINEAGE / domain.inconsistent)',
      },
    }),
  ];
}

/** The CheckPlan rows as evidence facts (the kernel gate-guard input shape). */
export function whatFreezeCheckPlanEvidence() {
  return whatFreezeCheckPlanRows().map((row) => ({
    kind: 'CheckPlan',
    ref: `checkplan:${row.checkId}#${row.digest.slice(0, 16)}`,
    producer: 'external-input',
    payloadDigest: row.digest,
  }));
}

/* ------------------------------------------------------------------ */
/* The declared semantic gates                                         */
/* ------------------------------------------------------------------ */

/** The freeze/settle verdict vocabulary (the kernel's frozen five). */
export const WHAT_FREEZE_VERDICTS = Object.freeze([
  'accepted',
  'repair',
  'upstream-repair',
  'human-wait',
  'terminal-reject',
]);

export function whatFreezeGateDeclarations() {
  return [
    {
      gateId: FREEZE_AUTHOR_GATE_ID,
      command: 'workplace.runAuthorGate',
      requiredEvidenceKinds: ['CandidateSet:author', 'CheckPlan'],
      verdictVocabulary: [...WHAT_FREEZE_VERDICTS],
      rules: [
        { when: { checkId: 'what-freeze.check.surfaces-carried', outcome: 'fail' }, verdict: 'human-wait' },
        { when: { checkId: 'what-freeze.check.surfaces-carried', outcome: 'operator-only' }, verdict: 'human-wait' },
        { when: { checkId: 'what-freeze.check.legacy-fold-refused', outcome: 'fail' }, verdict: 'repair' },
        { when: { checkId: 'what-freeze.check.no-folding', outcome: 'fail' }, verdict: 'human-wait' },
        { when: { checkId: 'what-freeze.check.exact-authority-ingestion', outcome: 'fail' }, verdict: 'human-wait' },
      ],
    },
    {
      gateId: FREEZE_FINAL_GATE_ID,
      command: 'workplace.runFinalGate',
      requiredEvidenceKinds: ['CandidateSet:reviewer', 'CheckPlan'],
      verdictVocabulary: [...WHAT_FREEZE_VERDICTS],
      rules: [
        { when: { checkId: 'what-freeze.check.wp03-validator', outcome: 'pass' }, verdict: 'accepted' },
        { when: { checkId: 'what-freeze.check.wp03-validator', outcome: 'fail' }, verdict: 'repair' },
      ],
    },
    {
      gateId: FREEZE_DRIFT_GATE_ID,
      command: 'workplace.settleEffect',
      requiredEvidenceKinds: ['AcceptedCandidateAuthority', 'CheckPlan'],
      verdictVocabulary: [...WHAT_FREEZE_VERDICTS],
      waitOn: { verdict: 'human-wait', waitKind: 'TypedWait:effect-uncertainty' },
      rules: [
        // The drift decision is operator-only: the declared rule yields
        // human-wait - the machine never confirms inconsistent itself and
        // never silently re-drives the uncertain freeze (D12).
        { when: { checkId: 'what-freeze.check.drift-disposition', outcome: 'operator-only' }, verdict: 'human-wait' },
      ],
    },
    {
      gateId: SETTLE_FINAL_GATE_ID,
      command: 'workplace.runFinalGate',
      requiredEvidenceKinds: ['CandidateSet:reviewer', 'CheckPlan'],
      verdictVocabulary: [...WHAT_FREEZE_VERDICTS],
      rules: [
        { when: { checkId: 'what-freeze.check.settlement-authority-pins', outcome: 'fail' }, verdict: 'terminal-reject' },
        { when: { checkId: 'what-freeze.check.settlement-binding-resolution', outcome: 'fail' }, verdict: 'upstream-repair' },
        { when: { checkId: 'what-freeze.check.settlement-binding-resolution', outcome: 'pass' }, verdict: 'accepted' },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The pure gate evaluator                                             */
/* ------------------------------------------------------------------ */

/** One check result row fed to the evaluator. */
export const CHECK_OUTCOMES = Object.freeze(['pass', 'fail', 'operator-only']);

/**
 * Evaluate one declared gate over its check results: the FIRST matching
 * declared rule wins; a check outside the gate's rules, or no rule
 * matching an all-machine check set, is refused typed (never a default
 * verdict, never an invented one).
 */
export function evaluateWhatFreezeGate(gate, results) {
  const known = new Set(gate.rules.map((rule) => rule.when.checkId));
  for (const result of results) {
    if (!known.has(result.checkId)) {
      return { refused: true, code: 'GATE_UNKNOWN_CHECK', detail: `check ${result.checkId} is outside gate ${gate.gateId}'s declared rules` };
    }
  }
  for (const rule of gate.rules) {
    const result = results.find((entry) => entry.checkId === rule.when.checkId);
    if (result === undefined) continue;
    if (result.outcome === rule.when.outcome) {
      return { decided: true, verdict: rule.verdict, rule };
    }
  }
  return {
    refused: true,
    code: 'GATE_RULES_CANNOT_DECIDE',
    detail: `no declared rule of gate ${gate.gateId} matches the check results [${results.map((entry) => `${entry.checkId}:${entry.outcome}`).join(', ')}]; an undecided gate never defaults`,
  };
}

/**
 * The deterministic machine checks: reduce a freeze desk RESULT to
 * CheckPlan rows (the same rows the evaluator consumes). The mapping is
 * a pure function of the result's outcome and typed refusal.
 */
export function machineChecksOfFreezeResult(freezeResult) {
  const rows = [];
  if (freezeResult.ok !== true) {
    return [{ checkId: 'what-freeze.check.wp03-validator', outcome: 'fail' }];
  }
  if (freezeResult.outcome === 'frozen') {
    rows.push({ checkId: 'what-freeze.check.surfaces-carried', outcome: 'pass' });
    rows.push({ checkId: 'what-freeze.check.legacy-fold-refused', outcome: 'pass' });
    rows.push({ checkId: 'what-freeze.check.no-folding', outcome: 'pass' });
    rows.push({ checkId: 'what-freeze.check.exact-authority-ingestion', outcome: 'pass' });
    rows.push({ checkId: 'what-freeze.check.wp03-validator', outcome: 'pass' });
    return rows;
  }
  const reason = freezeResult.refusal?.reason;
  if (freezeResult.outcome === 'indeterminate') {
    rows.push({ checkId: 'what-freeze.check.surfaces-carried', outcome: 'fail' });
    return rows;
  }
  if (freezeResult.outcome === 'drift-detected') {
    // Which drift check fired is a function of the refusal reason/detail:
    // the no-folding law and the exact-authority law both drift.
    if (reason === 'MALFORMED_PRODUCT' && /folded legacy/i.test(freezeResult.refusal.detail)) {
      rows.push({ checkId: 'what-freeze.check.legacy-fold-refused', outcome: 'fail' });
      return rows;
    }
    if (/section|folding|disposition|evidence/i.test(freezeResult.refusal.detail)) {
      rows.push({ checkId: 'what-freeze.check.no-folding', outcome: 'fail' });
      return rows;
    }
    rows.push({ checkId: 'what-freeze.check.exact-authority-ingestion', outcome: 'fail' });
    return rows;
  }
  rows.push({ checkId: 'what-freeze.check.wp03-validator', outcome: 'fail' });
  return rows;
}
