/**
 * FRF-WP02 forward-graph artifact validator (deterministic, self-contained).
 *
 * Scope: INTERNAL CONSISTENCY of forward-graph.json only. This script
 * re-derives nothing from the production source and never imports the
 * installed manifest - the graph's independence from production validators
 * is the whole point of FRF-WP02 (plan: "Expected graphs must not be
 * generated from production validators or production flow output").
 *
 * Checks:
 *   V1  identity + digest: graphDigest equals sha256 over the canonical
 *       (recursively key-sorted, compact) JSON of the "graph" body;
 *   V2  determinism: every object in the file is key-sorted as written,
 *       and no timestamp-like key exists inside the graph body;
 *   V3  counts: 11 nodes (6 production-cell / 2 kernel / 3 terminal),
 *       18 edges, terminals list == kind:terminal nodes, entry exists;
 *   V4  edge integrity: endpoints exist, events in the declared vocabulary,
 *       no duplicates, edge set is exactly (from x on) unique;
 *   V5  degree: entry has no in-edge (and exactly 1 out-edge class), every
 *       other nonterminal has >=1 in and >=1 out edge, terminals have 0 out;
 *   V6  reachability: every node reachable from entry; primaryPath is a
 *       real walk over declared edges ending at a terminal;
 *   V7  desk integrity: desk descriptors complete, product kinds in the
 *       declared vocabulary, per-desk shared evidence flag, refusal reasons
 *       in vocabulary, verdictOfReason total over refusalReasons;
 *   V8  lineage closure: walking primaryPath, every desk's consumed
 *       accepted-material kind is available (handoff seed or produced by an
 *       earlier desk); each produced kind has exactly one producing desk;
 *   V9  edge obligation classes: success-class edges carry the advance trio,
 *       failure-class edges carry the failure pair (internal consistency of
 *       the artifact's own obligation model);
 *   V10 citations resolve: path:line refs point at existing files with
 *       enough lines; path#Section>Sub refs point at existing files whose
 *       heading lines contain every segment; every node, edge and finding
 *       carries at least one citation.
 *
 * Usage:
 *   node docs/refactoring/formalization-frf/graphs/forward/validate.mjs
 *   node --test docs/refactoring/formalization-frf/graphs/forward/validate.mjs
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');
const ARTIFACT = path.join(HERE, 'forward-graph.json');

/* ---------- canonical rule (mirrors the kernel's digest.ts, self-contained) ---------- */

const sortKeys = (value) => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(sortKeys(value));

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/* ---------- validation ---------- */

export function validate(rawDocument = readFileSync(ARTIFACT, 'utf8')) {
  const findings = [];
  const fail = (code, detail) => findings.push({ code, detail });

  const doc = JSON.parse(rawDocument);
  const graph = doc.graph;

  // V1 identity + digest
  if (doc.artifactId !== 'frf-wp02-forward-graph') fail('V1', `artifactId is ${doc.artifactId}`);
  if (doc.schemaVersion !== 'frf.forward-graph.v1') fail('V1', `schemaVersion is ${doc.schemaVersion}`);
  if (typeof graph !== 'object' || graph === null) {
    fail('V1', 'graph body missing');
    return findings;
  }
  const recomputed = 'sha256:' + sha256(canonicalJson(graph));
  if (doc.graphDigest !== recomputed) fail('V1', `graphDigest ${doc.graphDigest} != recomputed ${recomputed}`);

  // V2 determinism: keys sorted as written + no timestamp-like keys
  const checkSorted = (value, where) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => checkSorted(entry, `${where}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      const keys = Object.keys(value);
      const sorted = [...keys].sort();
      if (keys.join('\u0000') !== sorted.join('\u0000')) {
        fail('V2', `object at ${where} is not key-sorted as written (${keys.join(',')} vs ${sorted.join(',')})`);
      }
      for (const key of keys) checkSorted(value[key], `${where}.${key}`);
    }
  };
  checkSorted(JSON.parse(rawDocument), '$');

  const timestampLike = /(date|time|stamp|createdAt|capturedAt|generatedAt)/i;
  const scanTimestamps = (value, where) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => scanTimestamps(entry, `${where}[${index}]`));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (timestampLike.test(key)) fail('V2', `timestamp-like key ${where}.${key} inside the graph body`);
        scanTimestamps(child, `${where}.${key}`);
      }
    }
  };
  scanTimestamps(graph, '$.graph');

  // V3 counts
  const nodes = graph.nodes;
  const nodeIds = Object.keys(nodes ?? {});
  const byKind = (kind) => nodeIds.filter((id) => nodes[id].kind === kind);
  if (nodeIds.length !== graph.counts.nodes) fail('V3', `counts.nodes ${graph.counts.nodes} but ${nodeIds.length} node entries`);
  for (const [kind, expected] of [['production-cell', 6], ['kernel', 2], ['terminal', 3]]) {
    if (byKind(kind).length !== graph.counts[kind === 'production-cell' ? 'productionCells' : kind === 'kernel' ? 'kernelNodes' : 'terminalNodes']) {
      fail('V3', `counts mismatch for kind ${kind}`);
    }
    if (byKind(kind).length !== expected) fail('V3', `kind ${kind}: ${byKind(kind).length} nodes, expected ${expected}`);
  }
  if (nodeIds.length !== 11) fail('V3', `expected 11 nodes, found ${nodeIds.length}`);
  const terminals = [...(graph.terminals ?? [])].sort();
  const terminalNodes = byKind('terminal').sort();
  if (terminals.join(',') !== terminalNodes.join(',')) fail('V3', `terminals list ${terminals.join(',')} != terminal-kind nodes ${terminalNodes.join(',')}`);
  if (!(graph.entry in nodes)) fail('V3', `entry ${graph.entry} is not a node`);

  // V4 edge integrity
  const edges = graph.edges ?? [];
  if (edges.length !== graph.counts.edges) fail('V4', `counts.edges ${graph.counts.edges} but ${edges.length} edge entries`);
  if (edges.length !== 18) fail('V4', `expected 18 edges, found ${edges.length}`);
  const seenEdge = new Set();
  for (const edge of edges) {
    if (!(edge.from in nodes)) fail('V4', `edge from ${edge.from} unknown`);
    if (!(edge.to in nodes)) fail('V4', `edge to ${edge.to} unknown`);
    if (!graph.edgeEventVocabulary.includes(edge.on)) fail('V4', `edge event ${edge.on} outside vocabulary`);
    const key = `${edge.from} --${edge.on}--> ${edge.to}`;
    if (seenEdge.has(key)) fail('V4', `duplicate edge ${key}`);
    seenEdge.add(key);
    if (!Array.isArray(edge.obligationsCreated) || edge.obligationsCreated.length === 0) {
      fail('V4', `edge ${key} creates no obligations`);
    } else {
      for (const obligation of edge.obligationsCreated) {
        if (!/^obligation:[a-zA-Z]/.test(obligation)) fail('V4', `edge ${key} malformed obligation ${obligation}`);
      }
      const sorted = [...edge.obligationsCreated].sort();
      if (sorted.join(',') !== [...edge.obligationsCreated].join(',')) fail('V2', `edge ${key} obligationsCreated not sorted`);
    }
    if (!Array.isArray(edge.citations) || edge.citations.length === 0) fail('V10', `edge ${key} has no citation`);
  }

  // V5 degree
  const inDegree = Object.fromEntries(nodeIds.map((id) => [id, 0]));
  const outDegree = Object.fromEntries(nodeIds.map((id) => [id, 0]));
  for (const edge of edges) {
    outDegree[edge.from] += 1;
    inDegree[edge.to] += 1;
  }
  if (inDegree[graph.entry] !== 0) fail('V5', `entry ${graph.entry} has ${inDegree[graph.entry]} in-edges`);
  if (outDegree[graph.entry] < 1) fail('V5', `entry ${graph.entry} has no out-edge`);
  for (const id of nodeIds) {
    if (id === graph.entry) continue;
    if (inDegree[id] < 1) fail('V5', `node ${id} has no in-edge`);
    if (nodes[id].kind !== 'terminal' && outDegree[id] < 1) fail('V5', `nonterminal ${id} has no out-edge`);
    if (nodes[id].kind === 'terminal' && outDegree[id] !== 0) fail('V5', `terminal ${id} has ${outDegree[id]} out-edges`);
  }

  // V6 reachability + primary path
  const successors = Object.fromEntries(nodeIds.map((id) => [id, []]));
  for (const edge of edges) successors[edge.from].push(edge);
  const reachable = new Set([graph.entry]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...reachable]) {
      for (const edge of successors[id]) {
        if (!reachable.has(edge.to)) {
          reachable.add(edge.to);
          grew = true;
        }
      }
    }
  }
  for (const id of nodeIds) {
    if (!reachable.has(id)) fail('V6', `node ${id} is unreachable from the entry`);
  }
  const primaryPath = graph.primaryPath ?? [];
  for (let i = 0; i + 1 < primaryPath.length; i += 1) {
    const hop = edges.find((edge) => edge.from === primaryPath[i] && edge.to === primaryPath[i + 1]);
    if (hop === undefined) fail('V6', `primaryPath hop ${primaryPath[i]} -> ${primaryPath[i + 1]} is not a declared edge`);
  }
  const last = primaryPath[primaryPath.length - 1];
  if (nodes[last]?.kind !== 'terminal') fail('V6', `primaryPath ends at ${last}, which is not a terminal`);

  // V7 desk integrity + vocabularies
  const vocabularies = graph.vocabularies ?? {};
  for (const obligationClass of ['refusalReasons', 'gateVerdicts', 'productKinds', 'acceptedMaterialKinds']) {
    if (!Array.isArray(vocabularies[obligationClass]) || vocabularies[obligationClass].length === 0) {
      fail('V7', `vocabulary ${obligationClass} missing or empty`);
    }
  }
  const deskNodes = nodeIds.filter((id) => nodes[id].desk !== undefined);
  if (deskNodes.length !== 8) fail('V7', `expected 8 desk nodes (6 cells + 2 kernel), found ${deskNodes.length}`);
  for (const id of deskNodes) {
    const node = nodes[id];
    for (const field of ['checkProviderId', 'effectId', 'operatorStaffed', 'outputProductKind', 'validator']) {
      if (!(field in node.desk)) fail('V7', `desk ${id} misses desk.${field}`);
    }
    if (!vocabularies.productKinds.includes(node.desk.outputProductKind)) {
      fail('V7', `desk ${id} product kind ${node.desk.outputProductKind} outside vocabulary`);
    }
    if (node.sharedEvidenceKinds !== true) fail('V7', `desk ${id} must produce the sharedDeskPath desk evidence kinds`);
    if (!Array.isArray(node.evidenceKinds) || node.evidenceKinds.length === 0) fail('V7', `desk ${id} lists no own evidence kinds`);
    if (nodes[id].kind === 'kernel' && node.desk.operatorStaffed !== true) fail('V7', `kernel desk ${id} must be operator-staffed`);
    if (nodes[id].kind === 'production-cell' && node.desk.operatorStaffed !== false) fail('V7', `cell desk ${id} must not be operator-staffed`);
    if (!Array.isArray(node.semanticFences) || node.semanticFences.length === 0) fail('V7', `desk ${id} records no semantic fence`);
    for (const fence of node.semanticFences ?? []) {
      if (!vocabularies.refusalReasons.includes(fence.refusal)) fail('V7', `fence of ${id} refusal ${fence.refusal} outside vocabulary`);
    }
  }
  for (const id of byKind('terminal')) {
    if (typeof nodes[id].emitsOutcome !== 'string' || nodes[id].emitsOutcome.length === 0) fail('V7', `terminal ${id} emits no outcome`);
    if (nodes[id].desk !== undefined) fail('V7', `terminal ${id} must not have a desk`);
  }
  const verdictMap = graph.sharedDeskPath?.verdictOfReason ?? {};
  const refusalSet = new Set(vocabularies.refusalReasons ?? []);
  if (new Set(Object.keys(verdictMap)).size !== refusalSet.size || [...refusalSet].some((reason) => !(reason in verdictMap))) {
    fail('V7', `verdictOfReason is not total over refusalReasons (${Object.keys(verdictMap).join(',')})`);
  }
  for (const verdict of Object.values(verdictMap)) {
    if (!vocabularies.gateVerdicts.includes(verdict)) fail('V7', `verdict ${verdict} outside gate verdict vocabulary`);
  }
  const sharedCommands = graph.sharedDeskPath?.commands ?? [];
  const commandNames = sharedCommands.map((entry) => entry.command);
  if (new Set(commandNames).size !== commandNames.length) fail('V7', 'sharedDeskPath commands contain duplicates');
  for (const entry of sharedCommands) {
    if (!/^([a-zA-Z]+Run|[a-zA-Z]+Attempt|workItem|workplace|cognition|nodeRun|processRun|stageRun|factoryRun|lifecycleRun)\./.test(entry.command)) {
      fail('V7', `shared command ${entry.command} is not a kernel command name`);
    }
    if (!Array.isArray(entry.createsObligations)) fail('V7', `shared command ${entry.command} misses createsObligations`);
  }

  // V8 lineage closure over the primary path
  const producedBy = new Map();
  for (const id of deskNodes) {
    for (const kind of nodes[id].produces?.acceptedMaterial ?? []) {
      if (producedBy.has(kind)) fail('V8', `accepted-material kind ${kind} produced by both ${producedBy.get(kind)} and ${id}`);
      producedBy.set(kind, id);
    }
  }
  const kindsVocabulary = new Set(vocabularies.acceptedMaterialKinds ?? []);
  for (const kind of [...producedBy.keys(), 'handoff']) {
    if (!kindsVocabulary.has(kind)) fail('V8', `accepted-material kind ${kind} outside vocabulary`);
  }
  const available = new Set(['handoff']);
  const deskOrder = primaryPath.filter((id) => nodes[id].desk !== undefined);
  for (const id of deskOrder) {
    for (const kind of nodes[id].consumes?.acceptedMaterial ?? []) {
      if (!available.has(kind)) fail('V8', `desk ${id} consumes ${kind} before any desk produced it`);
      if (!kindsVocabulary.has(kind)) fail('V8', `desk ${id} consumes ${kind} outside the vocabulary`);
    }
    for (const kind of nodes[id].produces?.acceptedMaterial ?? []) available.add(kind);
  }

  // V9 edge obligation classes (internal model consistency)
  const ADVANCE_TRIO = ['obligation:advanceProcessFlow', 'obligation:advanceProcessFlow.settle', 'obligation:freezeCandidate'];
  const FAILURE_PAIR = ['obligation:propagateNodeFailure', 'obligation:recordStageOutcome.failed'];
  for (const edge of edges) {
    const created = edge.obligationsCreated.join(',');
    const isTerminalTarget = nodes[edge.to]?.kind === 'terminal';
    if (['domain.accepted', 'domain.frozen', 'domain.formalized'].includes(edge.on)) {
      if (!ADVANCE_TRIO.every((obligation) => edge.obligationsCreated.includes(obligation))) {
        fail('V9', `success edge ${edge.from} --${edge.on}--> ${edge.to} misses the advance trio`);
      }
      if (isTerminalTarget && !edge.obligationsCreated.includes('obligation:recordStageOutcome')) {
        fail('V9', `flow-terminal edge ${edge.from} --${edge.on}--> ${edge.to} must also settle the process`);
      }
    } else if (['domain.failed', 'domain.drift-detected', 'domain.inconsistent'].includes(edge.on)) {
      if (created !== FAILURE_PAIR.join(',')) {
        fail('V9', `failure edge ${edge.from} --${edge.on}--> ${edge.to} carries [${created}], expected the failure pair`);
      }
      if (!isTerminalTarget) fail('V9', `failure-class edge ${edge.from} --${edge.on}--> ${edge.to} must target a terminal`);
    } else {
      fail('V9', `edge event ${edge.on} is neither success- nor failure-class`);
    }
  }
  for (const id of byKind('terminal')) {
    const declared = [...(nodes[id].obligationsCreated ?? [])].sort().join(',');
    const expected = id === 'complete-formalized'
      ? ['obligation:recordStageOutcome', 'obligation:replayCaptureSweep', 'obligation:routeLifecycle', 'obligation:runSettlement'].join(',')
      : FAILURE_PAIR.sort().join(',');
    if (declared !== expected) fail('V9', `terminal ${id} obligations [${declared}] != expected [${expected}]`);
  }

  // V10 citations resolve
  const headingCache = new Map();
  const loadFile = (relative) => {
    const absolute = path.join(REPO_ROOT, relative.replaceAll('\\', '/'));
    if (!existsSync(absolute)) return undefined;
    if (!headingCache.has(absolute)) {
      const lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
      headingCache.set(absolute, { lines, headings: lines.filter((line) => /^#{1,6} /.test(line)) });
    }
    return headingCache.get(absolute);
  };
  const checkCitation = (citation, where) => {
    if (typeof citation.ref !== 'string' || citation.ref.length === 0) {
      fail('V10', `${where}: citation without ref`);
      return;
    }
    const sectionMatch = citation.ref.match(/^([^#]+\.md)#(.+)$/);
    if (sectionMatch !== null) {
      const file = loadFile(sectionMatch[1]);
      if (file === undefined) {
        fail('V10', `${where}: cited file ${sectionMatch[1]} does not exist`);
        return;
      }
      for (const segment of sectionMatch[2].split('>')) {
        const needle = segment.trim();
        if (!file.headings.some((heading) => heading.replace(/^#{1,6} /, '').trim() === needle)) {
          fail('V10', `${where}: section heading "${needle}" not found in ${sectionMatch[1]}`);
        }
      }
      return;
    }
    const lineMatch = citation.ref.match(/^(.+):(\d+)(?:-(\d+))?$/);
    if (lineMatch === null) {
      fail('V10', `${where}: citation ref ${citation.ref} matches neither path:lines nor path.md#Section`);
      return;
    }
    const file = loadFile(lineMatch[1]);
    if (file === undefined) {
      fail('V10', `${where}: cited file ${lineMatch[1]} does not exist`);
      return;
    }
    const start = Number(lineMatch[2]);
    const end = lineMatch[3] === undefined ? start : Number(lineMatch[3]);
    if (!(start >= 1 && start <= end)) fail('V10', `${where}: bad line range ${start}-${end}`);
    if (end > file.lines.length) fail('V10', `${where}: ${lineMatch[1]} has ${file.lines.length} lines, citation reaches ${end}`);
  };
  const walkCitations = (value, where) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walkCitations(entry, `${where}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      if (typeof value.ref === 'string' && typeof value.note === 'string') {
        checkCitation(value, where);
        return;
      }
      for (const [key, child] of Object.entries(value)) walkCitations(child, `${where}.${key}`);
    }
  };
  walkCitations(graph, '$.graph');
  for (const node of Object.values(nodes)) {
    if (!Array.isArray(node.citations) || node.citations.length === 0) fail('V10', `node ${node.id ?? '?'} has no citation`);
  }
  for (const finding of graph.structuralFindings ?? []) {
    if (!Array.isArray(finding.citations) || finding.citations.length === 0) fail('V10', `finding ${finding.id} has no citation`);
  }

  return findings;
}

/* ---------- dual-mode entry (direct run + node --test) ---------- */

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

test('forward-graph.json validates clean (V1..V10)', () => {
  const findings = validate();
  if (findings.length > 0) {
    throw new Error(`forward-graph.json has ${findings.length} finding(s):\n` + findings.map((f) => `  [${f.code}] ${f.detail}`).join('\n'));
  }
});

if (isDirectRun) {
  const findings = validate();
  if (findings.length === 0) {
    console.log('frf-wp02-forward-graph: VALID (V1..V10 clean)');
  } else {
    console.error(`frf-wp02-forward-graph: INVALID (${findings.length} finding(s))`);
    for (const finding of findings) console.error(`  [${finding.code}] ${finding.detail}`);
    process.exitCode = 1;
  }
}
