#!/usr/bin/env node
// FRF-WP02 (reverse half) — deterministic validator for reverse-graph.json.
//
// Run: node docs/refactoring/formalization-frf/graphs/reverse/validate.mjs
//
// Checks (all blocking):
//   V1  file is byte-identical to its canonical form (recursively sorted keys,
//       2-space indent, trailing newline) — the determinism gate
//   V2  no timestamp-like keys anywhere in the body
//   V3  nodes: unique ids, sorted by id, known kind, lawful chainRole,
//       non-empty resolvable authority citations
//   V4  edges: unique ids, sorted by id, from/to resolve to nodes, resolvable
//       authority / bindingKind / obligationKind / grammarRule references,
//       via arrays unique; no duplicate (from,to) pair
//   V5  chainRole structure: claim = no incoming + >=1 outgoing;
//       material = >=1 incoming AND >=1 outgoing; leaf-authority = no
//       outgoing + >=1 incoming
//   V6  reachability: every node is reachable from the terminal claims
//       following reverse edges (from -> to)
//   V7  claims cite existing artifacts (every claim has >=1 outgoing edge to
//       a material node)
//   V8  vocabulary closure: every handoff binding kind, WorkItem obligation
//       kind, and trace grammar rule is used by at least one edge; closed
//       vocabularies are internally unique
//   V9  authority registry closure: every declared authority is cited by at
//       least one node/edge/rule; every citation resolves
//   V10 id-bearing sections (coverageRules, exclusions, ambiguities,
//       residuals) are unique and sorted

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const graphPath = path.join(here, 'reverse-graph.json');

const errors = [];
let checks = 0;
const ok = (cond, msg) => {
  checks += 1;
  if (!cond) errors.push(msg);
};

const raw = readFileSync(graphPath, 'utf8');
let g;
try {
  g = JSON.parse(raw);
} catch (e) {
  console.error(`FAIL: reverse-graph.json does not parse: ${e.message}`);
  process.exit(1);
}

// ---------- V1: canonical byte form ----------
function canonicalStringify(value, indent = '') {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = value.map((v) => canonicalStringify(v, indent + '  ')).join(',\n' + indent + '  ');
    return '[\n' + indent + '  ' + inner + '\n' + indent + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    if (keys.length === 0) return '{}';
    const inner = keys
      .map((k) => JSON.stringify(k) + ': ' + canonicalStringify(value[k], indent + '  '))
      .join(',\n' + indent + '  ');
    return '{\n' + indent + '  ' + inner + '\n' + indent + '}';
  }
  return JSON.stringify(value);
}
ok(raw === canonicalStringify(g) + '\n', 'V1: file is not in canonical form (sorted keys, 2-space indent, trailing newline)');

// ---------- V2: no timestamps ----------
const timestampKey = /^(createdAt|updatedAt|generatedAt|generated|timestamp|date|time)$/i;
const walkKeys = (v, p) => {
  if (Array.isArray(v)) {
    v.forEach((x, i) => walkKeys(x, `${p}[${i}]`));
  } else if (v !== null && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      ok(!timestampKey.test(k), `V2: timestamp-like key "${k}" at ${p}`);
      walkKeys(val, `${p}.${k}`);
    }
  }
};
walkKeys(g, '$');

// ---------- shape ----------
for (const key of ['artifact', 'version', 'derivation', 'authorities', 'vocabularies', 'nodes', 'edges', 'coverageRules', 'exclusions', 'ambiguities', 'residuals']) {
  ok(g[key] !== undefined, `top-level key "${key}" missing`);
}
ok(g.artifact === 'frf-reverse-graph', `unexpected artifact id "${g.artifact}"`);
ok(g.version === 1, `unexpected version ${g.version}`);

// ---------- V3/V4: registries ----------
const nodeIds = new Set();
const sortedIds = (arr) => arr.map((n) => n.id);
ok(
  JSON.stringify(sortedIds(g.nodes)) === JSON.stringify([...sortedIds(g.nodes)].sort()),
  'V3: nodes are not sorted by id'
);
ok(
  JSON.stringify(sortedIds(g.edges)) === JSON.stringify([...sortedIds(g.edges)].sort()),
  'V4: edges are not sorted by id'
);

const nodeKinds = new Set(Object.keys(g.vocabularies.nodeKinds || {}));
for (const n of g.nodes) {
  ok(!nodeIds.has(n.id), `V3: duplicate node id ${n.id}`);
  nodeIds.add(n.id);
  ok(typeof n.label === 'string' && n.label.length > 0, `V3: node ${n.id} missing label`);
  ok(typeof n.description === 'string' && n.description.length > 0, `V3: node ${n.id} missing description`);
  ok(nodeKinds.has(n.kind), `V3: node ${n.id} has unknown kind "${n.kind}"`);
  ok(['claim', 'material', 'leaf-authority'].includes(n.chainRole), `V3: node ${n.id} has unknown chainRole "${n.chainRole}"`);
  ok(typeof n.layer === 'string' && n.layer.length > 0, `V3: node ${n.id} missing layer`);
  ok(Array.isArray(n.authority) && n.authority.length > 0, `V3: node ${n.id} has no authority citations`);
  ok(new Set(n.authority).size === n.authority.length, `V3: node ${n.id} has duplicate authority citations`);
}

const authorityIds = new Set(Object.keys(g.authorities));
const citedAuthorities = new Set();
const cite = (id, where) => {
  ok(authorityIds.has(id), `V9: authority citation "${id}" at ${where} does not resolve`);
  citedAuthorities.add(id);
};

const bindingKinds = new Set(Object.keys(g.vocabularies.handoffBindingKinds?.values || {}));
const obligationKinds = new Set(Object.keys(g.vocabularies.workItemObligationKinds?.values || {}));
const grammarRules = new Set(Object.keys(g.vocabularies.traceGrammarRules || {}));

const edgeIds = new Set();
const pairSeen = new Set();
const usedBindings = new Set();
const usedObligations = new Set();
const usedGrammar = new Set();

for (const e of g.edges) {
  ok(!edgeIds.has(e.id), `V4: duplicate edge id ${e.id}`);
  edgeIds.add(e.id);
  ok(nodeIds.has(e.from), `V4: edge ${e.id} from "${e.from}" does not resolve`);
  ok(nodeIds.has(e.to), `V4: edge ${e.id} to "${e.to}" does not resolve`);
  const pair = `${e.from} -> ${e.to}`;
  ok(!pairSeen.has(pair), `V4: duplicate (from,to) pair "${pair}"`);
  pairSeen.add(pair);
  ok(typeof e.kind === 'string' && e.kind.length > 0, `V4: edge ${e.id} missing kind`);
  ok(Array.isArray(e.authority) && e.authority.length > 0, `V4: edge ${e.id} has no authority citations`);
  ok(new Set(e.authority).size === e.authority.length, `V4: edge ${e.id} has duplicate authority citations`);
  for (const a of e.authority) cite(a, `edge ${e.id}`);
  if (e.bindingKind !== undefined) {
    ok(bindingKinds.has(e.bindingKind), `V4: edge ${e.id} has unknown bindingKind "${e.bindingKind}"`);
    usedBindings.add(e.bindingKind);
  }
  if (e.obligationKind !== undefined) {
    ok(obligationKinds.has(e.obligationKind), `V4: edge ${e.id} has unknown obligationKind "${e.obligationKind}"`);
    usedObligations.add(e.obligationKind);
  }
  if (e.grammarRule !== undefined) {
    ok(grammarRules.has(e.grammarRule), `V4: edge ${e.id} has unknown grammarRule "${e.grammarRule}"`);
    usedGrammar.add(e.grammarRule);
  }
  if (e.via !== undefined) {
    ok(Array.isArray(e.via) && e.via.length > 0, `V4: edge ${e.id} via must be a non-empty array`);
    ok(new Set(e.via).size === e.via.length, `V4: edge ${e.id} via has duplicates`);
  }
}

// ---------- V5: chainRole structure ----------
const outgoing = new Map([...nodeIds].map((id) => [id, 0]));
const incoming = new Map([...nodeIds].map((id) => [id, 0]));
const outgoingTargets = new Map([...nodeIds].map((id) => [id, new Set()]));
for (const e of g.edges) {
  outgoing.set(e.from, outgoing.get(e.from) + 1);
  incoming.set(e.to, incoming.get(e.to) + 1);
  outgoingTargets.get(e.from).add(e.to);
}
for (const n of g.nodes) {
  const out = outgoing.get(n.id);
  const inc = incoming.get(n.id);
  if (n.chainRole === 'claim') {
    ok(inc === 0, `V5: claim ${n.id} has ${inc} incoming edges (must have none)`);
    ok(out >= 1, `V5: claim ${n.id} has no outgoing citations`);
  } else if (n.chainRole === 'material') {
    ok(inc >= 1, `V5: material ${n.id} is never cited (no incoming edges)`);
    ok(out >= 1, `V5: material ${n.id} cites nothing upstream (no outgoing edges)`);
  } else if (n.chainRole === 'leaf-authority') {
    ok(out === 0, `V5: leaf-authority ${n.id} has ${out} outgoing edges (must have none)`);
    ok(inc >= 1, `V5: leaf-authority ${n.id} is never cited (no incoming edges)`);
  }
}

// ---------- V6: reachability from terminal claims ----------
const claims = g.nodes.filter((n) => n.chainRole === 'claim').map((n) => n.id);
const expectedTerminals = ['complete-failed', 'complete-formalized', 'complete-inconsistent'];
const claimTerminals = new Set(claims.map((id) => id.split('/')[1]));
for (const t of expectedTerminals) {
  ok(claimTerminals.has(t), `V6: terminal ${t} has no claims`);
  ok(claims.filter((id) => id.split('/')[1] === t).length >= 1, `V6: terminal ${t} must have at least one claim`);
}
for (const t of claimTerminals) {
  ok(expectedTerminals.includes(t), `V6: claim cites unknown terminal "${t}"`);
}
const seen = new Set(claims);
const queue = [...claims];
while (queue.length > 0) {
  const id = queue.shift();
  for (const target of outgoingTargets.get(id) || []) {
    if (!seen.has(target)) {
      seen.add(target);
      queue.push(target);
    }
  }
}
for (const n of g.nodes) {
  ok(seen.has(n.id), `V6: node ${n.id} is not reachable from any terminal claim`);
}

// ---------- V7: claims cite existing artifacts ----------
for (const c of claims) {
  const materialTargets = [...outgoingTargets.get(c)].filter((t) => t.startsWith('material/'));
  ok(materialTargets.length >= 1, `V7: claim ${c} cites no material artifact`);
}

// ---------- V8: vocabulary closure ----------
for (const bk of bindingKinds) {
  ok(usedBindings.has(bk), `V8: handoff binding kind "${bk}" is never used by an edge`);
}
for (const okKind of obligationKinds) {
  ok(usedObligations.has(okKind), `V8: WorkItem obligation kind "${okKind}" is never used by an edge`);
}
for (const gr of grammarRules) {
  ok(usedGrammar.has(gr), `V8: trace grammar rule "${gr}" is never used by an edge`);
}
for (const [name, vocab] of Object.entries({
  actorKinds: g.vocabularies.actorKinds,
  evidenceKinds: g.vocabularies.evidenceKinds,
  planInvalidOmissions: g.vocabularies.planInvalidOmissions,
})) {
  ok(Array.isArray(vocab?.values) && vocab.values.length > 0, `V8: vocabulary ${name} missing values`);
  ok(new Set(vocab.values).size === vocab.values.length, `V8: vocabulary ${name} has duplicates`);
}
for (const [name, expected] of [
  ['actorKinds', 5],
  ['evidenceKinds', 4],
  ['planInvalidOmissions', 5],
  ['handoffBindingKinds', 12],
  ['workItemObligationKinds', 5],
  ['intentDispositions', 4],
]) {
  const entry = g.vocabularies[name];
  const size = Array.isArray(entry?.values) ? entry.values.length : Object.keys(entry?.values || {}).length;
  ok(size === expected, `V8: vocabulary ${name} has ${size} values, expected ${expected}`);
}
// traceGrammarRules and nodeKinds are bare-keyed (id -> text)
const grammarRuleCount = Object.keys(g.vocabularies.traceGrammarRules || {}).length;
ok(grammarRuleCount === 8, `V8: vocabulary traceGrammarRules has ${grammarRuleCount} rules, the plan's grammar declares 8`);
const nodeKindCount = Object.keys(g.vocabularies.nodeKinds || {}).length;
const usedNodeKindCount = new Set(g.nodes.map((n) => n.kind)).size;
ok(
  nodeKindCount === usedNodeKindCount,
  `V8: vocabulary nodeKinds declares ${nodeKindCount} kinds but nodes use ${usedNodeKindCount}`
);
// nodeKinds must cover every node kind used
for (const n of g.nodes) {
  ok(g.vocabularies.nodeKinds?.[n.kind] !== undefined, `V8: nodeKinds vocabulary lacks kind "${n.kind}"`);
}

// ---------- V9: authority registry closure ----------
for (const n of g.nodes) for (const a of n.authority) cite(a, `node ${n.id}`);
for (const sec of ['coverageRules', 'exclusions', 'ambiguities']) {
  for (const item of g[sec]) {
    ok(Array.isArray(item.authority) && item.authority.length > 0, `V9: ${sec} ${item.id} has no authority citations`);
    for (const a of item.authority || []) cite(a, `${sec} ${item.id}`);
  }
}
for (const id of authorityIds) {
  ok(citedAuthorities.has(id), `V9: declared authority "${id}" is never cited`);
}

// ---------- V10: id-bearing sections ----------
for (const sec of ['coverageRules', 'exclusions', 'ambiguities', 'residuals']) {
  const ids = g[sec].map((x) => x.id);
  ok(new Set(ids).size === ids.length, `V10: ${sec} has duplicate ids`);
  ok(JSON.stringify(ids) === JSON.stringify([...ids].sort()), `V10: ${sec} is not sorted by id`);
  for (const item of g[sec]) {
    ok(typeof item.statement === 'string' && item.statement.length > 0, `V10: ${sec} ${item.id} missing statement`);
  }
}

// ---------- report ----------
const claimsCount = claims.length;
const materialsCount = g.nodes.length - claimsCount;
console.log(`reverse-graph.json: ${g.nodes.length} nodes (${claimsCount} claims, ${materialsCount} materials), ${g.edges.length} edges, ${g.coverageRules.length} coverage rules, ${authorityIds.size} authorities, ${checks} checks`);
if (errors.length > 0) {
  console.error(`FAIL: ${errors.length} violation(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('OK: reverse graph is internally consistent and canonical.');
