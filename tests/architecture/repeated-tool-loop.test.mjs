import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepeatedToolLoopDetector } from '../../tracker-view/repeated-tool-loop.mjs';

const event = (name, input) => `${JSON.stringify({
  type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] },
})}\n`;

test('exact repeated tool calls trip at the configured bound', () => {
  const detector = createRepeatedToolLoopDetector({ limit: 3 });
  assert.equal(detector.push(event('Read', { file_path: 'missing.md' })), null);
  assert.equal(detector.push(event('Read', { file_path: 'missing.md' })), null);
  assert.equal(detector.push(event('Read', { file_path: 'missing.md' }))?.repetitions, 3);
});

test('different action resets the exact repetition count', () => {
  const detector = createRepeatedToolLoopDetector({ limit: 3 });
  detector.push(event('Read', { file_path: 'missing.md' }));
  detector.push(event('Read', { file_path: 'missing.md' }));
  detector.push(event('Write', { file_path: 'missing.md', content: 'created' }));
  assert.equal(detector.push(event('Read', { file_path: 'missing.md' })), null);
  assert.equal(detector.push(event('Read', { file_path: 'missing.md' })), null);
});

test('chunked JSONL is reconstructed', () => {
  const detector = createRepeatedToolLoopDetector({ limit: 2 });
  const line = event('Read', { file_path: 'a.md' });
  assert.equal(detector.push(line.slice(0, 12)), null);
  assert.equal(detector.push(line.slice(12)), null);
  assert.equal(detector.push(event('Read', { file_path: 'a.md' }))?.repetitions, 2);
});
