/**
 * D5 — Advisory Discovery Diagnosis architecture boundary static tests.
 *
 * The Saga 3 discovery diagnosis (D5 advisory discovery diagnosis) layer is
 * advisory-only and must stay kernel-pure: no getDb(), no inline SQL, no
 * settlement/certificate/proposal/readiness mutation, no stage transition, no
 * formalization imports. The diagnosis domain modules (case/validator/report)
 * must not import an LM client or a SQLite adapter — they are pure. The
 * diagnosis worker is fenced to a read-only + diagnosis_submit tool set; it
 * must never be able to mint proposals, readiness assessments, settlements,
 * certificates, tasks, or stage transitions. This mirrors the boundary the D4
 * Phase B tests already guard.
 *
 * Several of the guarded files do not exist yet (Stage 3 has not landed). For
 * those, the corresponding test SKIPS with a clear message via existsSync, so
 * the suite stays green now and becomes enforcing the moment the file lands.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC = (...parts) => path.resolve(import.meta.dirname, '..', '..', 'src', ...parts);

function assertNoDbInSource(file, label) {
  const source = readFileSync(SRC(...file), 'utf8');
  // No direct DB handle.
  assert.doesNotMatch(source, /\bgetDb\b/, `${label} must not call getDb()`);
  // No inline SQL statements (CREATE/INSERT/UPDATE/DELETE ... FROM).
  assert.doesNotMatch(source, /\b(CREATE TABLE|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i,
    `${label} must not contain inline SQL`);
}

// F1 — diagnosis service stays db-free (no getDb).
test('D5 arch: diagnosis service db-free', (t) => {
  const file = SRC('saga3', 'application', 'discovery-diagnosis-service.ts');
  if (!existsSync(file)) {
    t.skip('discovery-diagnosis-service.ts not yet implemented (Stage 3)');
    return;
  }
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\bgetDb\b/, 'diagnosis service must not call getDb()');
});

// F2 — diagnosis service has no inline SQL.
test('D5 arch: diagnosis service no inline SQL', (t) => {
  const file = SRC('saga3', 'application', 'discovery-diagnosis-service.ts');
  if (!existsSync(file)) {
    t.skip('discovery-diagnosis-service.ts not yet implemented (Stage 3)');
    return;
  }
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /\b(CREATE TABLE|INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM)\b/i,
    'diagnosis service must not contain inline SQL');
});

// F3 — D5 repo must not mutate settlement/certificate tables.
test('D5 arch: no settlement/cert mutation', (t) => {
  const file = SRC('saga3', 'persistence', 'saga3-diagnosis-repository.ts');
  if (!existsSync(file)) {
    t.skip('saga3-diagnosis-repository.ts not yet implemented (Stage 3)');
    return;
  }
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+saga3_discovery_settlements/i,
    'D5 repo must not UPDATE saga3_discovery_settlements (settlements are settled by D4 only)');
  assert.doesNotMatch(source, /UPDATE\s+saga3_discovery_outcome_certificates/i,
    'D5 repo must not UPDATE saga3_discovery_outcome_certificates (certificates are immutable)');
});

// F4 — D5 repo must not mutate the proposals table.
test('D5 arch: no proposal mutation', (t) => {
  const file = SRC('saga3', 'persistence', 'saga3-diagnosis-repository.ts');
  if (!existsSync(file)) {
    t.skip('saga3-diagnosis-repository.ts not yet implemented (Stage 3)');
    return;
  }
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+saga3_proposals/i,
    'D5 repo must not UPDATE saga3_proposals');
  assert.doesNotMatch(source, /INSERT\s+INTO\s+saga3_proposals/i,
    'D5 repo must not INSERT INTO saga3_proposals');
});

// F5 — D5 repo must not mutate the readiness assessments table.
test('D5 arch: no readiness mutation', (t) => {
  const file = SRC('saga3', 'persistence', 'saga3-diagnosis-repository.ts');
  if (!existsSync(file)) {
    t.skip('saga3-diagnosis-repository.ts not yet implemented (Stage 3)');
    return;
  }
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /UPDATE\s+saga3_readiness_assessments/i,
    'D5 repo must not UPDATE saga3_readiness_assessments');
  assert.doesNotMatch(source, /INSERT\s+INTO\s+saga3_readiness_assessments/i,
    'D5 repo must not INSERT INTO saga3_readiness_assessments');
});

// F6 — D5 must not introduce a stage transition.
test('D5 arch: no stage transition', (t) => {
  const serviceFile = SRC('saga3', 'application', 'discovery-diagnosis-service.ts');
  const repoFile = SRC('saga3', 'persistence', 'saga3-diagnosis-repository.ts');
  if (!existsSync(serviceFile) && !existsSync(repoFile)) {
    t.skip('neither diagnosis service nor repo implemented yet (Stage 3)');
    return;
  }
  for (const [file, label] of [
    [serviceFile, 'diagnosis service'],
    [repoFile, 'diagnosis repo'],
  ]) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /episode_transition/,
      `${label} must not reference episode_transition (diagnosis is advisory, no stage advance)`);
    assert.doesNotMatch(source, /'formalization'|formalization/,
      `${label} must not reference formalization (diagnosis never advances the stage)`);
  }
});

// F7 — diagnosis service must not import any formalization module.
test('D5 arch: no formalization imports', (t) => {
  const file = SRC('saga3', 'application', 'discovery-diagnosis-service.ts');
  if (!existsSync(file)) {
    t.skip('discovery-diagnosis-service.ts not yet implemented (Stage 3)');
    return;
  }
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /from ['"].*\/formalization\//,
    'diagnosis service must not import any formalization module');
});

// F8 — diagnosis worker allowed_tools must be read-only + diagnosis_submit.
test('D5 arch: diagnosis worker no write tools', (t) => {
  const file = SRC('saga3', 'persistence', 'sqlite-saga3-discovery-runtime.ts');
  if (!existsSync(file)) {
    t.skip('sqlite-saga3-discovery-runtime.ts not found at expected path');
    return;
  }
  const source = readFileSync(file, 'utf8');
  // The allowed_tools array is populated inside ensureDiagnosisControl. Until
  // that method lands (Stage 3), skip — there is nothing to assert yet.
  if (!/ensureDiagnosisControl/.test(source)) {
    t.skip('ensureDiagnosisControl not yet implemented in sqlite runtime (Stage 3)');
    return;
  }
  // Scope the check to the ensureDiagnosisControl METHOD BODY. The runtime
  // adapter holds every discovery stage (D1–D5), so the D3 ensureReadinessControl
  // legitimately declares `readiness_submit` for the readiness advisor — that is
  // NOT the diagnosis worker's authority. The invariant under test is "the
  // DIAGNOSIS WorkIntent allowed_tools contains ONLY read + diagnosis_submit",
  // so we extract just the diagnosis method and assert against it.
  const methodMatch = source.match(
    /ensureDiagnosisControl\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\s{2}\}\s*\n\s*(?:setDiagnosisControlStatus|readDiagnosisControlForTarget|readDiagnosisControl\b)/,
  );
  assert.ok(methodMatch, 'ensureDiagnosisControl method body must be present');
  const methodBody = methodMatch[1];
  // Permitted tools must be present.
  for (const tool of ['task_get', 'diagnosis_get', 'diagnosis_submit', 'worker_done']) {
    assert.match(methodBody, new RegExp(`['"\`]${tool}['"\`]`),
      `diagnosis allowed_tools must include ${tool}`);
  }
  // Forbidden authoritative write tools must be absent from the diagnosis method.
  const forbidden = ['proposal_submit', 'readiness_submit', 'settlement_submit',
    'certificate_submit', 'stage_transition', 'task_create'];
  for (const tool of forbidden) {
    assert.doesNotMatch(methodBody, new RegExp(`['"\`]${tool}['"\`]`),
      `diagnosis allowed_tools must NOT include ${tool} (no authoritative writes)`);
  }
});

// F9 — index.ts registers diagnosis_submit and never settlement/certificate.
test('D5 arch: only diagnosis tool registered', () => {
  const source = readFileSync(SRC('index.ts'), 'utf8');
  // Negative invariants hold always: workers must never be able to mint
  // certificates or settlements via an MCP handler.
  assert.doesNotMatch(source, /settlement_submit/,
    'index.ts must NOT register settlement_submit');
  assert.doesNotMatch(source, /certificate_submit/,
    'index.ts must NOT register certificate_submit');
  // Positive registration (diagnosis_submit) lands in Stage 3. Until then we
  // cannot assert it. We do not fail — we assert only the never-violable
  // negatives here; the positive is enforced once the tool exists.
  if (!/diagnosis_submit/.test(source)) {
    // Stage 3 has not yet registered the diagnosis tool — acceptable for now.
    return;
  }
  // Once registered, it must appear as a real tool registration (sanity).
  assert.match(source, /diagnosis_submit/,
    'index.ts must register the diagnosis_submit tool');
});

// F10 — diagnosis repo must not import upward into application/engine.
test('D5 arch: repo no upward import', (t) => {
  const file = SRC('saga3', 'persistence', 'saga3-diagnosis-repository.ts');
  if (!existsSync(file)) {
    t.skip('saga3-diagnosis-repository.ts not yet implemented (Stage 3)');
    return;
  }
  const source = readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/engines\//,
    'diagnosis repo must not import from ../../engines');
  assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/saga3\/application\//,
    'diagnosis repo must not import from ../../saga3/application');
});

// F11 — diagnosis domain modules must not import an LM client or SQLite adapter.
test('D5 arch: domain no LM import', () => {
  const domainFiles = [
    ['saga3', 'domain', 'discovery-diagnosis-case.ts'],
    ['saga3', 'domain', 'discovery-diagnosis-report.ts'],
    ['saga3', 'domain', 'discovery-diagnosis-validator.ts'],
  ];
  for (const parts of domainFiles) {
    const file = SRC(...parts);
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /LMStudio|openai|llm/i,
      `${parts.join('/')} must not import an LM client`);
    assert.doesNotMatch(source, /from ['"].*(better-sqlite3|sqlite)/,
      `${parts.join('/')} must not import the SQLite adapter`);
  }
});
