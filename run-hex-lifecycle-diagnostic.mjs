#!/usr/bin/env node
/**
 * HEX LIFECYCLE FLOW — diagnostic runner.
 *
 * Goal: validate hex-lifecycle-input.json against the REAL lifecycle input
 * contract (assertProductDeliveryLifecycleInput) and surface every mismatch
 * before committing to a full model-driven run. This is the FAST deterministic
 * smoke: no LM, no workers, just "is this input structurally acceptable?".
 *
 * Run: node run-hex-lifecycle-diagnostic.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const inputPath = path.join(root, 'hex-lifecycle-input.json');

const raw = JSON.parse(readFileSync(inputPath, 'utf8'));

const { assertProductDeliveryLifecycleInput } = await import(
  './dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { hashDevelopmentPolicy } = await import(
  './dist/modules/development/domain/development-settlement-policy.js'
);
const { hashDeliveryReleasePolicy } = await import(
  './dist/modules/delivery/domain/delivery-settlement-policy.js'
);

console.log('=== HEX LIFECYCLE DIAGNOSTIC ===\n');
console.log(`Input: ${inputPath}\n`);

// ---- Step 1: structural validation ----
let structuralError = null;
try {
  assertProductDeliveryLifecycleInput(raw);
  console.log('[1/3] assertProductDeliveryLifecycleInput: PASSED\n');
} catch (e) {
  structuralError = e;
  console.log(`[1/3] assertProductDeliveryLifecycleInput: FAILED`);
  console.log(`      ${e.message}\n`);
}

// ---- Step 2: development policy hash check ----
console.log('[2/3] development.policy.contentHash verification:');
const devPolicy = raw?.development?.policy;
if (!devPolicy) {
  console.log('      MISSING development.policy\n');
} else {
  const actual = hashDevelopmentPolicy(devPolicy);
  const declared = devPolicy.contentHash;
  const match = actual === declared;
  console.log(`      declared:  ${declared}`);
  console.log(`      computed:  ${actual}`);
  console.log(`      match:     ${match ? 'YES ✓' : 'NO ✗ — contentHash must equal computed hash'}\n`);
}

// ---- Step 3: delivery policy hash check ----
console.log('[3/3] delivery.policy.contentHash verification:');
const delPolicy = raw?.delivery?.policy;
if (!delPolicy) {
  console.log('      MISSING delivery.policy\n');
} else {
  const actual = hashDeliveryReleasePolicy(delPolicy);
  const declared = delPolicy.contentHash;
  const match = actual === declared;
  console.log(`      declared:  ${declared}`);
  console.log(`      computed:  ${actual}`);
  console.log(`      match:     ${match ? 'YES ✓' : 'NO ✗ — contentHash must equal computed hash'}\n`);
}

// ---- operatorAuthorization shape check ----
console.log('--- bonus: delivery.operatorAuthorization shape ---');
const auth = raw?.delivery?.operatorAuthorization;
if (!auth) {
  console.log('      MISSING delivery.operatorAuthorization\n');
} else {
  console.log(`      present keys: ${Object.keys(auth).join(', ')}`);
  const needs = ['schema', 'ref', 'hash', 'requestedBy', 'releasePolicyHash', 'candidateScope'];
  const missing = needs.filter(k => !(k in auth));
  if (missing.length === 0) {
    console.log('      required keys present ✓\n');
  } else {
    console.log(`      MISSING required keys: ${missing.join(', ')} ✗`);
    console.log('      (hex-lifecycle-input uses {operatorId,scopes} but the lifecycle');
    console.log('       contract requires DeliveryContentAddressedReference + auth fields)\n');
  }
}

// ---- summary ----
console.log('=== SUMMARY ===');
if (structuralError) {
  console.log(`STRUCTURAL FAIL: ${structuralError.message}`);
  console.log('hex-lifecycle-input.json is NOT accepted by the lifecycle input contract.');
  console.log('A full run would throw immediately at assertProductDeliveryLifecycleInput.');
  process.exit(1);
} else {
  console.log('Structural validation passed — input is acceptable for the lifecycle.');
  process.exit(0);
}
