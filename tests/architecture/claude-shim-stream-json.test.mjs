// E-S1 (stage-11 PREVENTIVE-HUNT, Layer 3): the repeated-tool-loop kill could
// never fire on the opencode backend — the runner passes
// `--output-format stream-json` (claude-runner.mjs), the shim dropped the flag
// (parseArgv), and opencode emitted ANSI TUI text on STDERR with 0 bytes on
// stdout, so every JSON.parse in repeated-tool-loop.mjs failed silently.
//
// Design (a): the shim recognizes `--output-format stream-json`, runs opencode
// with its native `--format json`, and translates the real opencode events into
// claude-compatible stream-json lines on stdout, so the detector — and every
// other stream-json consumer (lifecycle-endpoints tail view, token accounting)
// — works unmodified.
//
// The opencode event fixtures below are REAL captures (opencode 1.18.18,
// `opencode run --model zai-coding-plan/glm-4.7 --format json`, 2026-08-19,
// prompt: "Read the file alpha.txt … list the files …"): only the bulky
// state.output strings were trimmed (marked with "…[real output trimmed for
// fixture]"); every field the translator reads (type, part.tool, part.callID,
// part.state.status, part.state.input, part.text, part.tokens) is verbatim.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseArgv,
  createOpenCodeStreamTranslator,
} from '../../tools/agent-proxy/claude-shim.mjs';
import { createRepeatedToolLoopDetector } from '../../tracker-view/repeated-tool-loop.mjs';

const root = new URL('../../', import.meta.url);

// --- REAL captured opencode events (see header) -----------------------------

const OC_STEP_START =
  '{"type":"step_start","timestamp":1787138268455,"sessionID":"ses_fe64248c1ffeT4xyThvSemc697","part":{"id":"prt_019bddce5001vq7wqxDCg77vbs","messageID":"msg_019bdb8fc001MNeahrlP0zBwVZ","sessionID":"ses_fe64248c1ffeT4xyThvSemc697","snapshot":"b6d3fe107575ff3a178af4d30638dc849bb37766","type":"step-start"}}';

const OC_TOOL_USE_READ =
  '{"type":"tool_use","timestamp":1787138268514,"sessionID":"ses_fe64248c1ffeT4xyThvSemc697","part":{"type":"tool","tool":"read","callID":"tool-4da53b977dc849039bc44eef92eed4a1","state":{"status":"completed","input":{"filePath":"D:\\\\Development\\\\saga-mcp-es1\\\\.tmp-es1-capture\\\\alpha.txt"},"output":"<path>…[real output trimmed for fixture]"},"id":"prt_019bddcf9001EYoZaGByY56aKg","sessionID":"ses_fe64248c1ffeT4xyThvSemc697","messageID":"msg_019bdb8fc001MNeahrlP0zBwVZ"}}';

const OC_TOOL_USE_BASH =
  '{"type":"tool_use","timestamp":1787138268642,"sessionID":"ses_fe64248c1ffeT4xyThvSemc697","part":{"type":"tool","tool":"bash","callID":"tool-a04824fda33d4b7ab56e97577915fcdc","state":{"status":"completed","input":{"command":"ls -la"},"output":"total 15…[real output trimmed for fixture]"},"id":"prt_019bddd03001Mc1yW55pEc6OjM","sessionID":"ses_fe64248c1ffeT4xyThvSemc697","messageID":"msg_019bdb8fc001MNeahrlP0zBwVZ"}}';

const OC_STEP_FINISH_TOOL_CALLS =
  '{"type":"step_finish","timestamp":1787138269007,"sessionID":"ses_fe64248c1ffeT4xyThvSemc697","part":{"id":"prt_019bddf49001kwcb9fNedRFOkZ","reason":"tool-calls","snapshot":"03d8da06a348c0567e842f72ab070336059f5854","messageID":"msg_019bdb8fc001MNeahrlP0zBwVZ","sessionID":"ses_fe64248c1ffeT4xyThvSemc697","type":"step-finish","tokens":{"total":8279,"input":237,"output":39,"reasoning":67,"cache":{"write":0,"read":7936}},"cost":0}}';

const OC_STEP_FINISH_STOP =
  '{"type":"step_finish","timestamp":1787138272364,"sessionID":"ses_fe64248c1ffeT4xyThvSemc697","part":{"id":"prt_019bdec5e0014PM2f3OIVJ7lFp","reason":"stop","snapshot":"25b954b2d0cf7923e2afa401ea2e7f365680cea0","messageID":"msg_019bde0d6001N6axPzOtFwnCMC","sessionID":"ses_fe64248c1ffeT4xyThvSemc697","type":"step-finish","tokens":{"total":8555,"input":609,"output":1,"reasoning":9,"cache":{"write":0,"read":7936}},"cost":0}}';

// Real text event from a separate capture (prompt: "What is 2+2? …").
const OC_TEXT =
  '{"type":"text","timestamp":1787138383889,"sessionID":"ses_fe6408d1fffeItGSsqaALiap7W","part":{"id":"prt_019bfa00e0010HWpumuEzQ33U4","messageID":"msg_019bf74840014ncOd27nVYlgLu","sessionID":"ses_fe6408d1fffeItGSsqaALiap7W","type":"text","text":"4","time":{"start":1787138383886,"end":1787138383889}}}';

// The full REAL event sequence of the captured session.
const OC_REAL_SESSION = [
  OC_STEP_START,
  OC_TOOL_USE_READ,
  OC_TOOL_USE_BASH,
  OC_STEP_FINISH_TOOL_CALLS,
  OC_STEP_START,
  OC_STEP_FINISH_STOP,
];

// --- helpers -----------------------------------------------------------------

function translateAll(lines) {
  const t = createOpenCodeStreamTranslator();
  let out = '';
  for (const line of lines) out += t.push(line + '\n');
  out += t.finish();
  return out;
}

function translatedAssistantToolLines(out) {
  return out.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.type === 'assistant')
    .flatMap(e => e.message.content)
    .filter(b => b.type === 'tool_use');
}

// --- the E-S1 regression: the kill must fire on the opencode backend ---------

test('characterization: RAW opencode --format json lines never trip the claude-shaped detector (why the shim must translate)', () => {
  // Even with opencode's native json format, the event shape is
  // {"type":"tool_use","part":{...}} — NOT claude's
  // {"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}.
  // Fed straight to the detector, any number of repetitions parses to nothing.
  const detector = createRepeatedToolLoopDetector({ limit: 12 });
  for (let i = 0; i < 50; i++) {
    const line = OC_TOOL_USE_READ.replace(
      'tool-4da53b977dc849039bc44eef92eed4a1',
      `tool-4da53b977dc849039bc44eef92eed4a${String(i).padStart(2, '0')}`,
    );
    assert.equal(detector.push(`${line}\n`), null);
  }
});

test('twelve identical real opencode tool_use events trip the 12-repetition kill through the shim translation', () => {
  // The same tool call repeated 12 times with identical input, each event
  // re-using the REAL captured shape (only callID varies, as opencode does).
  const repeated = Array.from({ length: 12 }, (_, i) => OC_TOOL_USE_READ.replace(
    'tool-4da53b977dc849039bc44eef92eed4a1',
    `tool-4da53b977dc849039bc44eef92eed4a${String(i).padStart(2, '0')}`,
  ));

  const detector = createRepeatedToolLoopDetector({ limit: 12 });
  let violation = null;
  for (const line of translatedAssistantToolLines(translateAll(repeated))) {
    violation = detector.push(`${JSON.stringify({
      type: 'assistant', message: { content: [line] },
    })}\n`) ?? violation;
  }
  assert.ok(violation, 'the repeated-tool-loop kill must fire on the opencode backend');
  assert.equal(violation.tool, 'read');
  assert.equal(violation.repetitions, 12);
});

test('eleven identical opencode tool calls do not trip the 12-repetition kill', () => {
  const repeated = Array.from({ length: 11 }, (_, i) => OC_TOOL_USE_READ.replace(
    'tool-4da53b977dc849039bc44eef92eed4a1',
    `tool-4da53b977dc849039bc44eef92eed4a${String(i).padStart(2, '0')}`,
  ));
  const detector = createRepeatedToolLoopDetector({ limit: 12 });
  let violation = null;
  for (const line of translatedAssistantToolLines(translateAll(repeated))) {
    violation = detector.push(`${JSON.stringify({
      type: 'assistant', message: { content: [line] },
    })}\n`) ?? violation;
  }
  assert.equal(violation, null);
});

// --- translation contract against the real consumers -------------------------

test('opencode tool_use events become claude assistant/tool_use lines with name and input', () => {
  const out = translateAll(OC_REAL_SESSION);
  const toolBlocks = translatedAssistantToolLines(out);
  assert.equal(toolBlocks.length, 2);
  assert.deepEqual(toolBlocks[0], {
    type: 'tool_use',
    id: 'tool-4da53b977dc849039bc44eef92eed4a1',
    name: 'read',
    input: { filePath: 'D:\\Development\\saga-mcp-es1\\.tmp-es1-capture\\alpha.txt' },
  });
  assert.deepEqual(toolBlocks[1], {
    type: 'tool_use',
    id: 'tool-a04824fda33d4b7ab56e97577915fcdc',
    name: 'bash',
    input: { command: 'ls -la' },
  });
});

test('opencode text events become claude assistant/text lines (tail view contract)', () => {
  const out = translateAll([OC_TEXT]);
  const evt = JSON.parse(out.split(/\r?\n/).filter(Boolean)[0]);
  assert.equal(evt.type, 'assistant');
  assert.deepEqual(evt.message.content, [{ type: 'text', text: '4' }]);
});

test('finish() emits one claude result event with summed usage (token accounting contract)', () => {
  const out = translateAll(OC_REAL_SESSION);
  const results = out.split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
    .filter(e => e.type === 'result');
  assert.equal(results.length, 1);
  const usage = results[0].usage;
  // inputs+cache reads and outputs are summed across BOTH captured steps:
  // step1 (in 237 + cache.read 7936, out 39) + step2 (in 609 + cache.read 7936, out 1)
  assert.equal(usage.input_tokens, 237 + 609);
  assert.equal(usage.cache_read_input_tokens, 7936 + 7936);
  assert.equal(usage.output_tokens, 39 + 1);
});

test('a callID re-emitted by a state transition translates to exactly one assistant line', () => {
  const pending = JSON.parse(OC_TOOL_USE_READ);
  pending.part.state.status = 'pending';
  const t = createOpenCodeStreamTranslator();
  const a = t.push(`${JSON.stringify(pending)}\n`);
  const b = t.push(`${OC_TOOL_USE_READ}\n`);
  assert.equal(translatedAssistantToolLines(a + b).length, 1);
});

test('chunked opencode stdout is reassembled before translation', () => {
  const t = createOpenCodeStreamTranslator();
  const whole = OC_TOOL_USE_READ + '\n';
  const out = t.push(whole.slice(0, 40)) + t.push(whole.slice(40));
  assert.equal(translatedAssistantToolLines(out).length, 1);
});

// --- argv surface: the dropped flag is the root cause ------------------------

test('parseArgv consumes --output-format as a value flag instead of corrupting it into a positional', () => {
  const parsed = parseArgv([
    '-p', '--model', 'glm-4.7', '--output-format', 'stream-json',
    '--verbose', '--forward-subagent-text', '--no-session-persistence',
  ]);
  assert.equal(parsed.values['--output-format'], 'stream-json');
  assert.deepEqual(parsed.ignored, [], 'the runner argv must not leak ignored args');
  for (const flag of ['--verbose', '--forward-subagent-text', '--no-session-persistence']) {
    assert.ok(parsed.flags.has(flag), `${flag} is a known no-op bool`);
  }
});

// --- the runner kill-path stays wired (content pin; full spawn test needs a live model)

test('the production runner still pipes worker stdout into the repeated-tool-loop kill path', () => {
  const runner = readFileSync(new URL('tracker-view/claude-runner.mjs', root), 'utf8');
  assert.match(runner, /createRepeatedToolLoopDetector\(\{ limit: 12 \}\)/);
  assert.match(runner, /repeatedToolLoop\.push\(chunk\)/);
  assert.match(runner, /REPEATED_TOOL_LOOP: \$\{violation\.tool\} repeated \$\{violation\.repetitions\}/);
  assert.match(runner, /child\.kill\(\)/);
});
