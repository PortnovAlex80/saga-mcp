/**
 * replay-kit.test.mjs - the WP-13D Elite Evidence Kit replay suite: both
 * corpus entries replay green through the WP-08 public ingress + the
 * WP-09 conveyor, elite-8 terminates in the honest typed refusal family,
 * elite-fresh reaches its development-blocked outcome with the readiness
 * boundary intact, and the legacy-only behavior carries typed comparison
 * notes (never forced equality).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { replayKitEntry, KIT_ENTRIES } from '../../tools/project-corpus/lib/kit.mjs';

test('the kit corpus declares exactly the two entries', () => {
  assert.deepEqual(KIT_ENTRIES, ['elite-fresh-20260825', 'elite-8']);
});

for (const entryId of KIT_ENTRIES) {
  test(`replay: ${entryId} is green`, async () => {
    const result = await replayKitEntry(entryId);
    const red = result.checks.filter((check) => check.status === 'red');
    assert.equal(result.status, 'green', `${entryId} RED checks:\n${red.map((check) => `${check.id}: ${check.detail}`).join('\n')}`);
    assert.equal(check(result, 'capsule-ingress').status, 'green');
    assert.equal(check(result, 'mandatory-transitions').status, 'green');
    assert.equal(check(result, 'gate-verdict-sequence').status, 'green');
  });
}

test('replay: elite-8 terminates in the honest typed refusal family', async () => {
  const result = await replayKitEntry('elite-8');
  assert.ok(result.normalized.terminalProofs.includes('TerminalProof:run.truthful-failure'));
  assert.ok(result.normalized.terminalProofs.includes('TerminalProof:lifecycle.truthful-failure'));
  const honest = check(result, 'honest-typed-refusal-terminal');
  assert.equal(honest.status, 'green');
  const note = result.notes.find((entry) => entry.id === 'kit:legacy-failed');
  assert.ok(note !== undefined, 'the failed->truthful-failure vocabulary note is present');
});

test('replay: elite-fresh reaches development-blocked with the readiness boundary intact', async () => {
  const result = await replayKitEntry('elite-fresh-20260825');
  assert.ok(result.normalized.terminalProofs.includes('TerminalProof:run.truthful-failure'));
  const blocked = check(result, 'development-blocked-terminal');
  assert.equal(blocked.status, 'green');
  assert.match(blocked.detail, /readiness certification refused/);
  const note = result.notes.find((entry) => entry.id === 'kit:readiness-refusal');
  assert.ok(note !== undefined, 'the readiness-refusal witness note is present');
  /* The readiness boundary: the delivery stage never entered - exactly one
     stage outcome exists and it is the honest terminal one. */
  assert.equal(result.normalized.stageOutcomeEvents.length, 1);
});

test('replay: legacy-only behavior is recorded as typed notes, never forced equality', async () => {
  for (const entryId of KIT_ENTRIES) {
    const result = await replayKitEntry(entryId);
    const noteIds = result.notes.map((note) => note.id);
    assert.ok(noteIds.includes('kit:worker-process-streams'), `${entryId}: the exec#N process-stream note`);
    assert.ok(noteIds.includes('kit:mandatory-transitions'), `${entryId}: the stage-route mapping note`);
  }
  const elite8 = await replayKitEntry('elite-8');
  assert.ok(elite8.notes.some((note) => note.id === 'kit:repair-epoch-reduction'), 'the repair-epoch reduction note quantifies the replay bound');
  const fresh = await replayKitEntry('elite-fresh-20260825');
  assert.ok(fresh.notes.some((note) => note.id === 'kit:legacy-only-loss-transitions'), 'the DB-only loss-transition divergence note (journal-visibility witness)');
});

const check = (result, id) => result.checks.find((entry) => entry.id === id);
