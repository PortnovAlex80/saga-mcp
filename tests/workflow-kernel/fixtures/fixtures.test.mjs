/**
 * fixtures.test.mjs - the WP-13B production-size fixture generator: compact
 * descriptors -> deterministic, byte-exact payloads preserving the real
 * observed production classes (Elite-3 planner request 436,283 bytes,
 * repeated recovery, large accepted products, duplicate metadata, Unicode,
 * hook additionalContext, bounded tool results) at the three payload scales
 * (minimum / normal production / observed maximum).
 *
 * Committed bytes stay small (the generator + descriptors); generated
 * artifacts are reproducible from the retained seed on any machine.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  FIXTURE_CLASSES,
  FIXTURE_SCALES,
  OBSERVED_PRODUCTION,
  fixtureCorpus,
  fixtureTargetBytes,
  generateFixture,
} from '../../../dist/workflow-kernel/testing/fixtures.js';
import { countTokens } from '../../../dist/workflow-kernel/context-envelope/accountant.js';
import { accountEnvelope } from '../../../dist/workflow-kernel/context-envelope/accountant.js';
import { budgetLimitTable, budgetProfile, DRIVER_ROUTE_PIN } from '../../../dist/workflow-kernel/testing/dimension-drivers.js';

const SEED = 20260826;

test('the corpus is closed: 7 observed classes x 3 scales, every artifact byte-exact', () => {
  assert.equal(FIXTURE_CLASSES.length, 7);
  assert.equal(FIXTURE_SCALES.length, 3);
  const corpus = fixtureCorpus(SEED);
  assert.equal(corpus.length, 21);
  for (const fixture of corpus) {
    assert.equal(fixture.byteLength, fixtureTargetBytes(fixture.descriptor), `${fixture.descriptor.kind}/${fixture.descriptor.scale}: byte-exact`);
    assert.ok(fixture.tokenCount > 0);
    assert.match(fixture.sha256, /^[0-9a-f]{64}$/);
  }
});

test('the observed maximum planner request is the exact Elite-3 figure: 436,283 bytes', () => {
  const elite3 = generateFixture({ kind: 'planner-request', scale: 'observed-maximum', seed: SEED });
  assert.equal(OBSERVED_PRODUCTION.elite3PlannerRequestBytes, 436283);
  assert.equal(elite3.byteLength, 436283, 'docs/factory-run/stage20-elite/RUN-TRACKER.md:214 - the provider-rejected retry prompt');
  // The snowball shape: unboundedly repeated gate-rejection feedback blocks.
  const rejections = elite3.text.match(/epoch \d+ rejected:/g) ?? [];
  assert.ok(rejections.length > 1000, `the feedback repeats unboundedly (${rejections.length} blocks)`);
  assert.ok(elite3.text.includes('overlap without a dependency order'), 'the pairwise-overlap rejection class is preserved');
  assert.ok(elite3.text.includes('16+16'), 'the earlier ACCEPTED submission figure is preserved');
  // Token accounting uses the kernel's own pinned counter.
  assert.equal(elite3.tokenCount, countTokens(elite3.text));
});

test('generation is deterministic: same descriptor -> identical bytes and digest; seed changes the stream', () => {
  const a = generateFixture({ kind: 'accepted-product', scale: 'normal', seed: SEED });
  const b = generateFixture({ kind: 'accepted-product', scale: 'normal', seed: SEED });
  assert.equal(a.text, b.text);
  assert.equal(a.sha256, b.sha256);
  const c = generateFixture({ kind: 'accepted-product', scale: 'normal', seed: SEED + 1 });
  assert.notEqual(a.sha256, c.sha256);
});

test('the observed classes preserve their real shapes', () => {
  const unicode = generateFixture({ kind: 'unicode-content', scale: 'normal', seed: SEED });
  assert.ok(/[А-я]/.test(unicode.text) && /[\u4e00-\u9fff]/.test(unicode.text) && /é/.test(unicode.text), 'multi-script content (Cyrillic, CJK, diacritics)');
  assert.equal(unicode.byteLength, fixtureTargetBytes(unicode.descriptor), 'multi-script byte accounting is exact');

  const duplicate = generateFixture({ kind: 'duplicate-metadata', scale: 'normal', seed: SEED });
  const rows = duplicate.text.split(' ');
  const counts = new Map(rows.map((word) => [word, 0]));
  for (const word of rows) counts.set(word, (counts.get(word) ?? 0) + 1);
  assert.ok([...counts.values()].some((count) => count > 20), 'byte-identical metadata rows repeat');

  const recovery = generateFixture({ kind: 'recovery-history', scale: 'normal', seed: SEED });
  assert.ok(/recovery/.test(recovery.text) && /epoch/.test(recovery.text), 'the repeated recovery epoch class');

  const hook = generateFixture({ kind: 'hook-context', scale: 'observed-maximum', seed: SEED });
  assert.equal(hook.byteLength, 131072, 'an oversized hook additionalContext payload');

  const toolResult = generateFixture({ kind: 'tool-result', scale: 'normal', seed: SEED });
  assert.ok(/bounded/.test(toolResult.text) && /cap/.test(toolResult.text), 'bounded retained tool results');
});

test('committed bytes stay small: the generator module is a few KB, not the payload', () => {
  const modulePath = fileURLToPath(new URL('../../../dist/workflow-kernel/testing/fixtures.js', import.meta.url));
  const source = readFileSync(modulePath, 'utf8');
  const committed = Buffer.byteLength(source, 'utf8');
  const elite3 = generateFixture({ kind: 'planner-request', scale: 'observed-maximum', seed: SEED });
  assert.ok(committed < elite3.byteLength / 20, `committed ${committed}B generates ${elite3.byteLength}B (>=20x expansion)`);
});

test('production fixtures are mandatory for budget tests: the Elite-3 payload is refused by the byte backstop', () => {
  // The observed-maximum planner request as the tool-results layer of a
  // context envelope: the accountant must refuse it before any send (the
  // production incident class F-A, now a blocking law instead of a crash).
  const elite3 = generateFixture({ kind: 'planner-request', scale: 'observed-maximum', seed: SEED });
  const verdict = accountEnvelope(budgetProfile(), budgetLimitTable(), {
    providerRoutePin: DRIVER_ROUTE_PIN,
    nextRequestOrdinal: 1,
    cumulativeInputTokens: 0,
  }, {
    layers: [
      { layer: 'initial-prompt-frame', content: 'plan' },
      { layer: 'protocol-skill', content: 'plan' },
      { layer: 'semantic-skill', content: 'plan' },
      { layer: 'tool-schemas', content: 'plan' },
      { layer: 'write-authority', content: 'plan' },
      { layer: 'tool-results', content: elite3.text },
    ],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.violation, 'MAX_TOOL_RESULT_TOKENS_EXCEEDED', 'the tool-result layer budget refuses the snowball first');
  // And the payload alone exceeds the frozen byte backstop of every
  // coherent profile (no unlimited representation exists to admit it).
  assert.ok(elite3.byteLength > budgetProfile().maxPromptBytes, 'the observed-maximum payload cannot fit under maxPromptBytes');
});
