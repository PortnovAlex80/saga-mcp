#!/usr/bin/env node
// tests/factory-proof/workshop-inventory.mjs
//
// Refactor Phase 1 / R0 (PROCESS-MODULE-ARCHITECTURAL-REFACTORING-GUIDE,
// WORKSHOP-MODULARIZATION-REFACTORING-PLAN): the machine-readable
// per-workshop inventory + cross-tree dependency map, captured BEFORE any
// structural move. Pure test-side tooling: reads the conformance packs'
// declared topologies (no dist, no DB) and scans src/ import pairs.
//
// Usage:
//   node tests/factory-proof/workshop-inventory.mjs --json        # print inventory
//   node tests/factory-proof/workshop-inventory.mjs --baseline    # write the committed baseline
//   node tests/factory-proof/workshop-inventory.mjs --check       # fail on drift vs baseline

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { DEVELOPMENT_TOPOLOGY, DEVELOPMENT_PENDING_UNIVERSE, DEVELOPMENT_PLATFORM_FAULT_EDGES, DEVELOPMENT_SCENARIOS } from './development-scenario-pack.mjs';
import { DELIVERY_TOPOLOGY, DELIVERY_PENDING_UNIVERSE, DELIVERY_SCENARIOS } from './delivery-scenario-pack.mjs';
import { FORMALIZATION_TARGETS, FORMALIZATION_SCENARIOS, FORMALIZATION_PLATFORM_FAULT_EDGES } from './formalization-scenario-pack.mjs';
import { DISCOVERY_SCENARIOS } from './discovery-scenario-pack.mjs';
import { DOCUMENTATION_TOPOLOGY, DOCUMENTATION_PENDING_UNIVERSE, DOCUMENTATION_SCENARIOS } from './documentation-scenario-pack.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASELINE_PATH = path.join(import.meta.dirname, 'workshop-inventory.baseline.json');

const sha256 = value => createHash('sha256').update(value).digest('hex');

// --- Cross-tree dependency map (guide §1 diagnosis: the dual root) --------
function listFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      listFiles(full, acc);
    } else if (/\.(ts|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

function crossTreeDependencyMap() {
  const srcRoot = path.join(REPO_ROOT, 'src');
  const files = listFiles(srcRoot);
  const pairs = [];
  // The built-in workshop set (kept in one place so a new admission extends
  // the cross-tree map honestly instead of being silently uncounted).
  const moduleAlternation = '(?:discovery|formalization|development|delivery|documentation)';
  const importsModulesFromRe = new RegExp(`from\\s+'(?:\\.\\./)*modules/${moduleAlternation}/`);
  const importsModulesDynamicRe = new RegExp(`import\\('(?:\\.\\./)*modules/${moduleAlternation}/`);
  const inModulesTreeRe = new RegExp(`^src/modules/${moduleAlternation}/`);
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).replaceAll('\\', '/');
    const text = readFileSync(file, 'utf8');
    const importsLegacy = /from\s+'(\.\.\/)*process-modules\/modules\//.test(text)
      || /import\('(\.\.\/)*process-modules\/modules\//.test(text);
    const importsModules = importsModulesFromRe.test(text) || importsModulesDynamicRe.test(text);
    const inLegacyTree = rel.startsWith('src/process-modules/modules/');
    const inModulesTree = inModulesTreeRe.test(rel);
    if ((inModulesTree && importsLegacy) || (inLegacyTree && importsModules)) {
      pairs.push({ file: rel, direction: inModulesTree ? 'modules->legacy' : 'legacy->modules' });
    }
  }
  return pairs;
}

// --- The inventory ---------------------------------------------------------
export function buildWorkshopInventory() {
  const workshops = {
    discovery: {
      scenarios: DISCOVERY_SCENARIOS.map(s => s.id),
      nodes: ['produce-proposal', 'assess-readiness', 'settle'],
      pendingUniverse: null,
      platformFaultEdges: [],
    },
    formalization: {
      scenarios: FORMALIZATION_SCENARIOS.map(s => s.id),
      nodes: Object.values(FORMALIZATION_TARGETS).map(t => t.node),
      cells: Object.values(FORMALIZATION_TARGETS).map(t => t.cell),
      platformFaultEdges: FORMALIZATION_PLATFORM_FAULT_EDGES,
    },
    development: {
      scenarios: DEVELOPMENT_SCENARIOS.map(s => s.id),
      nodes: DEVELOPMENT_TOPOLOGY.nodes.map(n => n.id),
      outcomes: DEVELOPMENT_TOPOLOGY.outcomes,
      installedVariants: DEVELOPMENT_TOPOLOGY.installedVariants,
      pendingUniverse: DEVELOPMENT_PENDING_UNIVERSE,
      platformFaultEdges: DEVELOPMENT_PLATFORM_FAULT_EDGES,
    },
    delivery: {
      scenarios: DELIVERY_SCENARIOS.map(s => s.id),
      nodes: DELIVERY_TOPOLOGY.nodes.map(n => n.id),
      outcomes: DELIVERY_TOPOLOGY.outcomes,
      executionProfiles: DELIVERY_TOPOLOGY.executionProfiles,
      pendingUniverse: DELIVERY_PENDING_UNIVERSE,
      platformFaultEdges: [],
    },
    documentation: {
      scenarios: DOCUMENTATION_SCENARIOS.map(s => s.id),
      nodes: DOCUMENTATION_TOPOLOGY.nodes,
      outcomes: DOCUMENTATION_TOPOLOGY.outcomes,
      executionProfiles: DOCUMENTATION_TOPOLOGY.executionProfiles,
      pendingUniverse: DOCUMENTATION_PENDING_UNIVERSE,
      platformFaultEdges: [],
    },
  };
  const crossTree = crossTreeDependencyMap();
  const inventory = {
    schemaVersion: 'factory.proof.workshop-inventory.v1',
    workshops,
    crossTreeDependencies: {
      count: crossTree.length,
      modulesToLegacy: crossTree.filter(p => p.direction === 'modules->legacy').length,
      legacyToModules: crossTree.filter(p => p.direction === 'legacy->modules').length,
      files: crossTree.map(p => `${p.file} (${p.direction})`).sort(),
    },
  };
  inventory.inventoryDigest = sha256(JSON.stringify(inventory, null, 0));
  return inventory;
}

// --- CLI -------------------------------------------------------------------
const mode = process.argv[2] ?? '--json';
const inventory = buildWorkshopInventory();
if (mode === '--baseline') {
  writeFileSync(BASELINE_PATH, JSON.stringify(inventory, null, 2) + '\n');
  console.log(`baseline written: ${BASELINE_PATH} digest=${inventory.inventoryDigest.slice(0, 16)}…`);
} else if (mode === '--check') {
  if (!existsSync(BASELINE_PATH)) {
    console.error('WORKSHOP_INVENTORY_BASELINE_MISSING');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  if (baseline.inventoryDigest !== inventory.inventoryDigest) {
    console.error('WORKSHOP_INVENTORY_DRIFT: current inventory digest '
      + `${inventory.inventoryDigest.slice(0, 16)}… != baseline ${baseline.inventoryDigest.slice(0, 16)}…`);
    console.error('A structural change moved a workshop topology or the cross-tree '
      + 'dependency map — update the baseline DELIBERATELY (node tests/factory-proof/workshop-inventory.mjs --baseline) '
      + 'in the same commit as the move.');
    process.exit(1);
  }
  console.log(`inventory matches baseline (digest ${inventory.inventoryDigest.slice(0, 16)}…)`);
} else {
  console.log(JSON.stringify(inventory, null, 2));
}
