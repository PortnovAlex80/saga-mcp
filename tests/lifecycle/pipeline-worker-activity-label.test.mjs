import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeRuntimeStatus,
} from '../../tracker-view/lifecycle-pipeline/public/pipeline.js';

test('paused controller is displayed as active while durable workers run', () => {
  assert.deepEqual(describeRuntimeStatus('paused', 2), {
    cssStatus: 'in_progress',
    label: 'рабочие работают',
    title: 'Контроллер ожидает; 2 рабочих продолжают работу',
  });
});

test('paused remains an honest pause when no workers run', () => {
  assert.deepEqual(describeRuntimeStatus('paused', 0), {
    cssStatus: 'paused',
    label: 'paused',
    title: 'Завод на паузе; активных рабочих нет',
  });
});

test('non-paused runtime statuses are not reinterpreted', () => {
  assert.deepEqual(describeRuntimeStatus('failed', 3), {
    cssStatus: 'failed',
    label: 'failed',
    title: 'failed',
  });
});
