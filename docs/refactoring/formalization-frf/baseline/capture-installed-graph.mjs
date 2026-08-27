#!/usr/bin/env node
import { execSync } from 'node:child_process';
/**
 * FRF-WP01 — capture the INSTALLED Formalization process graph as a
 * versioned artifact (plan FRF-0: "Current graph capture").
 *
 * Imports the installed dist artifact (never the TS source) and records:
 *   - module identity (id, version, schemaVersion, manifestDigest);
 *   - the full node table (id, label, kind, desk descriptor, outcome);
 *   - the full edge table (from, to, on);
 *   - node/edge counts and kind tallies;
 *   - the installed check providers, role bindings, and skills/tools/hooks
 *     counts (the surfaces FRF-11 must keep pinned).
 *
 * Run: node docs/refactoring/formalization-frf/baseline/capture-installed-graph.mjs
 * (requires `npm run build`; output: installed-formalization-graph.json)
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distRoot = path.resolve(here, '..', '..', '..', '..');

const manifest = await import(
  pathToFileURL(path.join(distRoot, 'dist/workflow-kernel/workshops/formalization/manifest.js')).href
);

const installed = manifest.installedWorkshopManifest();
const kindTally = {};
for (const node of installed.flow.nodes) kindTally[node.kind] = (kindTally[node.kind] ?? 0) + 1;

const artifact = {
  artifactId: 'frf-wp01-installed-formalization-graph',
  schemaVersion: 'frf.installed-graph-capture.v1',
  capturedAt: new Date().toISOString(),
  capturedFrom: {
    baseSha: execSync('git rev-parse --short HEAD').toString().trim(),
    installedArtifact: 'dist/workflow-kernel/workshops/formalization/manifest.js',
    sourceFile: 'src/workflow-kernel/workshops/formalization/manifest.ts',
  },
  moduleIdentity: {
    moduleId: installed.moduleId,
    moduleVersion: installed.moduleVersion,
    schemaVersion: installed.schemaVersion,
    manifestDigest: installed.manifestDigest,
  },
  graph: {
    entryNodeId: installed.flow.entryNodeId,
    terminalNodeIds: installed.flow.terminalNodeIds,
    counts: {
      nodes: installed.flow.nodes.length,
      edges: installed.flow.edges.length,
      byKind: kindTally,
      productionCells: kindTally['production-cell'] ?? 0,
      kernelNodes: kindTally.kernel ?? 0,
      terminalNodes: kindTally.terminal ?? 0,
    },
    nodes: installed.flow.nodes,
    edges: installed.flow.edges,
    edgeEventVocabulary: manifest.FLOW_EDGE_EVENTS,
  },
  installedSurfaces: {
    checkProviders: installed.checkProviders.map((p) => ({
      providerId: p.providerId,
      nodeId: p.nodeId,
      productKind: p.productKind,
      validator: p.validator,
      providerDigest: p.providerDigest,
    })),
    roleBindings: installed.roleBindings,
    skills: installed.skills.length,
    semanticSkillsByDesk: installed.skills.filter((s) => s.kind === 'semantic').map((s) => s.servesDesks[0]),
    tools: installed.tools.length,
    hooks: installed.hooks.map((h) => ({ hookId: h.hookId, event: h.event })),
  },
};

const out = path.join(here, 'installed-formalization-graph.json');
await writeFile(out, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
console.log(`wrote ${path.relative(distRoot, out)}`);
console.log(JSON.stringify({
  moduleId: artifact.moduleIdentity.moduleId,
  manifestDigest: artifact.moduleIdentity.manifestDigest,
  counts: artifact.graph.counts,
}, null, 2));
