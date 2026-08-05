import { createPinnedClaudeWorkerExecutorFactory } from '../dist/infrastructure/workers/claude-worker-executor-factory.js';
import { getDb } from '../dist/db.js';

// Mock delivery port — proxy that returns async () => ({ok:true}) for any method
const mockDeliveryPort = new Proxy({}, {
  get() { return async () => ({ ok: true }); }
});

export async function createProductLifecycleComposition(ctx) {
  // Return the shape that selectEngine expects as overrides.productLifecycle
  // selectEngine will spread this into createProductLifecycleRuntime options
  return {
    db: getDb(),
    delivery: {
      preflightState: mockDeliveryPort,
      approval: mockDeliveryPort,
      publication: mockDeliveryPort,
      observation: mockDeliveryPort,
      settlementState: mockDeliveryPort,
    },
    // CLI checks productLifecycle.delivery for its own gate
    // This is what the final saga2 application sees
  };
}
