# План 2: Regression Test Suite

## Цель
10 тестовых файлов на golden material, покрывающих ADR-053 authority chain, replay integrity, obligation topology, traceability и crash recovery.

## Директория

```
tests/factory-regression-golden/
├── fixtures/
│   └── production-run-001/
│       ├── candidate-sets.json        # слой A: stable digests
│       ├── replay-capsules.json
│       ├── gate-decisions.json
│       ├── cell-final-acceptances.json
│       ├── process-outcome-certificates.json
│       ├── artifacts.json
│       ├── handoff-graph.json         # слой B: topology
│       ├── cardinalities.json
│       └── manifest.json              # source, date, git HEAD
├── extract-golden.mjs                 # генератор JSON из DB + git
├── digest-pinning.test.mjs            # §1: stable hashes не дрейфнули
├── topology-invariants.test.mjs       # §2: handoff counts, cardinality
├── referential-integrity.test.mjs     # §3: все cross-refs резолвятся
├── authority-chain.test.mjs           # §4: ADR-053 triangle
├── capsule-integrity.test.mjs         # §5: payload_hash reproducible
├── obligation-topology.test.mjs       # §6: 4 handoffs + source_kind
├── traceability.test.mjs             # §7: AC→UC→FR→NFR→RULE
├── semantic-digest.test.mjs          # §8: partition invariance
├── crash-recovery.test.mjs           # §9: forward path для non-terminal
└── product-git.test.mjs              # §10: git tree snapshot
```

## Что пиннать (stable) vs НЕ пиннать (unstable)

**Пиннать:**
- `candidate_set_digest`, `production_revision_ref` — sha256, content-addressed
- `payload_hash`, `replay_key` — детерминированы каноническим JSON
- `acceptance_digest`, `certificate_hash` — content-addressed
- `candidate_set_ref` — содержит revision hash, стабилен

**НЕ пиннать:**
- `*_at` timestamps
- `*_lease_ref`, `*_receipt_refs` с exec-UUID
- `seal_receipt_ref` (содержит exec-UUID)

## 10 тестов

### 1. digest-pinning.test.mjs
Для каждой таблицы: загрузить JSON-слепок, сравнить с live-чтением DB (readonly).
```js
test('candidate_set_digest matches golden', () => {
  const golden = loadFixture('candidate-sets.json');
  const live = db.prepare('SELECT candidate_set_ref, candidate_set_digest, production_revision_ref FROM factory_candidate_sets ORDER BY candidate_set_ref').all();
  assert.deepEqual(live, golden);
});
```

### 2. topology-invariants.test.mjs
Handoff-граф и cardinality.
```js
test('handoff distribution', () => {
  const counts = db.prepare('SELECT handoff_kind, COUNT(*) as n FROM factory_transition_obligations GROUP BY handoff_kind').all();
  assert.deepEqual(counts, [
    {handoff_kind:'record-final-acceptance', n:10},
    {handoff_kind:'run-effects', n:14},
    {handoff_kind:'run-gate', n:16},
    {handoff_kind:'settle-process', n:13},
  ]);
});
```

### 3. referential-integrity.test.mjs
Все cross-refs резолвятся — нет orphan'ов.
```js
test('every capsule source_candidate_set_ref resolves', () => {
  const orphans = db.prepare(`
    SELECT rc.source_candidate_set_ref FROM factory_replay_capsules rc
    LEFT JOIN factory_candidate_sets cs ON cs.candidate_set_ref=rc.source_candidate_set_ref
    WHERE cs.candidate_set_ref IS NULL`).all();
  assert.deepEqual(orphans, []);
});
```

### 4. authority-chain.test.mjs
ADR-053 triangle: CandidateSet → GateDecision → FinalAcceptance.
```js
test('final acceptance backed by accepted gate on same candidate set', () => {
  const broken = db.prepare(`
    SELECT fa.final_acceptance_ref FROM factory_cell_final_acceptances fa
    JOIN factory_gate_decisions gd ON gd.decision_key=fa.gate_decision_key
    WHERE gd.verdict!='accepted' OR gd.subject_candidate_set_ref!=fa.candidate_set_ref`).all();
  assert.deepEqual(broken, []);
});
```

### 5. capsule-integrity.test.mjs
`hashPayload(JSON.parse(payload_snapshot)) === payload_hash` для всех 13 капсул.
```js
test('capsule payload_hash reproducible', () => {
  const rows = db.prepare('SELECT replay_key, payload_hash, payload_snapshot FROM factory_replay_capsules').all();
  for (const r of rows) {
    assert.equal(hashPayload(JSON.parse(r.payload_snapshot)), r.payload_hash);
  }
});
```

### 6. obligation-topology.test.mjs
4 handoff kinds с правильным source_kind binding.
```js
test('obligation source→handoff mapping', () => {
  const allowed = new Set([
    'candidate-set-sealed|run-gate',
    'gate-accepted|run-effects',
    'effects-settled|record-final-acceptance',
    'final-acceptance-recorded|settle-process',
  ]);
  const bad = db.prepare("SELECT DISTINCT source_kind||'|'||handoff_kind AS pair FROM factory_transition_obligations")
    .all().filter(r => !allowed.has(r.pair));
  assert.deepEqual(bad, []);
});
```

### 7. traceability.test.mjs
AC → UC → FR → NFR → RULE. 0 orphan ACs.
```js
test('every AC traces to UC and PRD', () => {
  const orphanAC = db.prepare(`
    SELECT a.id FROM artifacts a
    LEFT JOIN artifact_traces tr ON tr.source_id=a.id AND tr.link_type='derived_from'
    WHERE a.type='AC' AND tr.id IS NULL`).all();
  assert.deepEqual(orphanAC, []);
});
```

### 8. semantic-digest.test.mjs
`production_revision_ref` пересобирается из members → тот же digest.
```js
test('revision digest reproducible from members', () => {
  // Для каждого CandidateSet: достать members, пересобрать revision,
  // проверить что digest совпадает с production_revision_ref
});
```

### 9. crash-recovery.test.mjs
Non-terminal workplaces имеют forward path.
```js
test('every non-terminal workplace has resume path', () => {
  const stuck = db.prepare("SELECT workplace_ref FROM factory_workplaces WHERE loop_state!='terminal' AND revision>0").all();
  for (const w of stuck) {
    const hasOblig = db.prepare("SELECT 1 FROM factory_transition_obligations WHERE source_ref LIKE ? LIMIT 1").get('%'+w.workplace_ref+'%');
    assert.ok(hasOblig, `stuck workplace: ${w.workplace_ref}`);
  }
});
```

### 10. product-git.test.mjs
Git tree snapshot — ловит случайную перезапись golden-репо.
```js
test('product git HEAD matches golden', () => {
  const head = execSync('git -C product rev-parse HEAD').toString().trim();
  assert.equal(head, 'fc2299c...');
});
```

## CI интеграция

```json
"test:factory-regression-golden": "node --test tests/factory-regression-golden/*.test.mjs"
```

Быстрые тесты (§1-3, 5-10) — на каждый PR (~ms).
Replay-тест (§4) — в slow-suite на push to main.

## Риск: все 53 obligations в `pending`
Reconciler driver не подключён. Пинать ТОЛЬКО `(source_kind, handoff_kind)` топологию. НЕ пинать `state` или `completion_receipt`.
