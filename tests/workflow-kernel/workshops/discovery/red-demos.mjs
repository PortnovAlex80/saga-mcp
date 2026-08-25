#!/usr/bin/env node
/**
 * red-demos.mjs - WP-11D RED demonstration patcher: applies ONE deliberate
 * source mutation (one per fence family), rebuilds, runs the pinned suite
 * and RESTORES. Never leaves a mutation behind.
 *
 * Families:
 *   schema-bypass       family 1 - the product schema/address fence
 *   conditional-identity family 2 - the role-pin identity fence
 *   wait-kind-invention family 3 - the wait vocabulary fence
 *
 * Usage: node tests/workflow-kernel/workshops/discovery/red-demos.mjs <name|all>
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const MUTATIONS = {
  'schema-bypass': {
    file: 'src/workflow-kernel/workshops/discovery/products.ts',
    old: `    if (!present || raw === undefined) {
      if (field.required) {
        return { refused: true, reason: 'MISSING_FIELD', field: field.name, detail: \`\${contract.contractId} requires \${field.name}\` };
      }
      continue;
    }`,
    new: `    if (!present || raw === undefined) {
      /* MUTATION: schema bypass - missing fields silently pass */ continue;
    }`,
    suite: 'tests/workflow-kernel/workshops/discovery/products.test.mjs',
  },
  'conditional-identity': {
    file: 'src/workflow-kernel/workshops/discovery/role-bindings.ts',
    old: `function viewOf(slot: ResolvedDiscoveryRoleSlot, consumer: RolePinView['consumer']): RolePinView {
  return Object.freeze({
    consumer,
    launchKind: slot.launchKind,
    protocolRole: slot.protocolRole,
    roleContractRef: slot.pin.roleContractRef,
    roleContractDigest: slot.pin.roleContractDigest,
    pin: slot.pin,
  });
}`,
    new: `function viewOf(slot: ResolvedDiscoveryRoleSlot, consumer: RolePinView['consumer']): RolePinView {
  return Object.freeze({
    consumer,
    launchKind: slot.launchKind,
    protocolRole: slot.protocolRole,
    roleContractRef: slot.pin.roleContractRef,
    roleContractDigest: slot.pin.roleContractDigest,
    /* MUTATION: each consumer view re-derives its own pin object (identity no longer transported) */
    pin: Object.freeze({ roleContractRef: slot.pin.roleContractRef, roleContractDigest: slot.pin.roleContractDigest }),
  });
}`,
    suite: 'tests/workflow-kernel/workshops/discovery/role-bindings.test.mjs',
  },
  'wait-kind-invention': {
    file: 'src/workflow-kernel/workshops/discovery/waits.ts',
    old: `  const frozen = WAITS.find((entry) => entry.kind === kind);
  if (frozen === undefined) {
    return {
      refused: true,
      reason: 'UNIVERSE_VIOLATION',
      detail: \`wait kind \${JSON.stringify(kind)} is not one of the five frozen kinds (invented wait kinds never enter the ledger; mutation w)\`,
    };
  }`,
    new: `  const frozen = WAITS.find((entry) => entry.kind === kind) ?? WAITS[0]; /* MUTATION: invented kinds fall through to the first frozen kind */`,
    suite: 'tests/workflow-kernel/workshops/discovery/waits.test.mjs',
  },
};

const run = (cmd) => execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const runSoft = (cmd) => {
  try {
    return { code: 0, output: execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

function demo(name) {
  const mutation = MUTATIONS[name];
  const fullPath = path.join(REPO_ROOT, mutation.file);
  const original = readFileSync(fullPath, 'utf8');
  if (!original.includes(mutation.old)) {
    console.log(`PATTERN NOT FOUND for ${name}`);
    return false;
  }
  writeFileSync(fullPath, original.replace(mutation.old, mutation.new), 'utf8');
  let redFailed = false;
  try {
    const build = runSoft('npm run build');
    if (build.code !== 0) {
      // The mutation cannot even compile: the type fence kills it.
      console.log(`=== RED ${name} (mutated) ===`);
      console.log('KILLED BY THE COMPILER FENCE (npm run build fails on the mutated source):');
      console.log(build.output.trim().split('\n').filter((line) => /error/.test(line)).slice(0, 4).join('\n'));
      redFailed = true;
    } else {
      const red = runSoft(`node --test "${mutation.suite}" 2>&1`);
      const redLines = red.output.trim().split('\n');
      redFailed = red.code !== 0 || /fail [1-9]/.test(red.output) || /✖|not ok /.test(red.output);
      console.log(`=== RED ${name} (mutated) ===`);
      console.log(redLines.slice(-12).join('\n'));
      console.log(`RED exit=${red.code} (expected nonzero)`);
    }
  } finally {
    writeFileSync(fullPath, original, 'utf8');
    run('npm run build');
    const restored = runSoft(`node --test "${mutation.suite}" 2>&1`);
    const pass = /# pass \d+/.exec(restored.output)?.[0] ?? '';
    console.log(`=== ${name} restored ===`);
    console.log(`${pass} (exit ${restored.code})`);
  }
  return redFailed;
}

const requested = process.argv[2];
if (requested === undefined) {
  console.log(`usage: node red-demos.mjs <${Object.keys(MUTATIONS).join('|')}|all>`);
  process.exit(2);
}
const names = requested === 'all' ? Object.keys(MUTATIONS) : [requested];
let anyRed = false;
for (const name of names) {
  const red = demo(name);
  console.log(`${name}: ${red ? 'RED proven (mutation killed)' : 'WARNING: mutation NOT killed - the fence is weak'}`);
  anyRed = anyRed || red;
}
process.exit(anyRed ? 0 : 1);
