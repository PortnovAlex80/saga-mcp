// tests/factory-contract/snapshot-stage11-scenarios.mjs
//
// SNAPSHOT-TEST tape: replay of the REAL stage-11 docking run
// (factory-snapshots/stage11-replay-fitness, captured 2026-08-19) against the
// CURRENT factory through the real orchestrate-cli / MCP-gateway seam.
//
// HARNESS NATURE (scoped claim): this is a replay/corpus REGRESSION — it
// proves the current factory still routes, gates and settles the captured
// byte-exact material through the same transition trace. It is NOT a semantic
// product oracle (nothing here asserts the PRD/SRS content is *good* — only
// that it is the captured, gate-accepted bytes) and NOT a replacement for a
// real worker spawn: the scripted executor substitutes the inference spawn
// seam only (CONVEYOR §23 L3 rule 9); assignment, desks, MCP/tool authority,
// submission, gates, effects and persistence stay production.
//
// Every text below is captured material served from the committed corpus
// tests/fixtures/golden-corpus/stage11-docking (harvested by
// tools/harvest-golden-corpus.mjs). Nothing is hand-written prose except the
// deterministic development TAIL (implement/verify/readiness), which the
// stage-11 capture cannot cover: the run was paused mid-implementation, and
// implementation results embed run-local git SHAs that no replay can
// reproduce. The tail reuses the golden-path scripted logic so the lifecycle
// can terminate (exit 0) after the tape crosses into solution-development.
//
// Covered cells (captured, byte-exact replay):
//   product-discovery@4.0.0        produce-proposal, assess-readiness
//   solution-formalization@1.0.0   define-product-contract (9 artifacts, 8 traces)
//                                  model-use-cases (2 artifacts, 6 traces)
//                                  define-acceptance-contract (5 artifacts, 14 traces)
//                                  reconcile-what (products only)
//                                  define-architecture-contract (SRS v2, 1 trace)
//   solution-development@1.4.4     plan-task-graph — the REAL 3-round repair loop:
//                                  proposal #1 gate-rejected, #2 gate-rejected,
//                                  #3 accepted, all replayed byte-exact.
//
// Documented deviation from the captured verdict sequence:
//   formalization-architecture-contract was captured as
//   [final repair_required -> final accepted] (SRS v1 rejected, v2 approved).
//   The v1 SRS BODY is not in the captured material (the journal has no
//   tool.call events — the known SNAP capture gap; the workspace tree only
//   holds the final v2 bytes). This tape replays the ACCEPTED round only;
//   both reviewer verdicts of that loop remain in the corpus for a future
//   E-GATE-1 scenario once the v1 body is re-captured. The repair-loop
//   theorem is still exercised on real material by the plan-task-graph cell.
//
// Fail-closed discipline: handlers verify the deterministic identities they
// depend on (artifact ids, trace ids, candidate-set refs) against the
// captured values and throw on mismatch — a replay drift is a loud failure,
// never a silent divergence.
//
// Documented grammar relays (production postdates the capture; every relay
// derives the new-grammar field STRICTLY from runtime authority and is
// verified by a dedicated parsed-content oracle in the reach test):
//   - brief artifact metadata: brief_payload + constraint dispositions;
//   - AC/SRS coverage: covered_constraint_ids (artifact metadata + one §D2
//     stanza field on the SRS document);
//   - reviewer verdicts: subject_candidate_set_ref rebound to the CURRENT
//     runtime author candidate (material stays byte-exact);
//   - planner proposals: acceptanceCriterionIds -> acceptanceCriterionKeys
//     (atomic `artifactId:code` identities of the same AC artifacts, read
//     from the runtime frozen development case — ADR-088 CC-GAP-6).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actions } from './scenario-engine.mjs';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { buildOrderConstraintRegisterV2 } from '../../dist/shared/constraint-register.js';
import {
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
  RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
} from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(__dirname, '../fixtures/golden-corpus/stage11-docking');

const FRM = 'solution-formalization@1.0.0';
const DISC = 'product-discovery@4.0.0';
const DEV = 'solution-development@1.4.4';

// --- corpus access (fail-closed; the corpus is the ONLY text source) -------
//
// Every read is content-verified against the manifest BEFORE the bytes can
// reach a handler: a missing file is a typed SNAPSHOT_CORPUS_FILE_MISSING, a
// corrupted byte is a typed SNAPSHOT_CORPUS_DRIFT (digest pair in the
// message). The negative suite (snapshot-corpus-negative.test.mjs) pins each
// failure mode; a corrupted corpus therefore turns every corpus-hosted suite
// red at load time instead of replaying decoy material.

function readCorpusBytes(root, relative) {
  let text;
  try {
    text = readFileSync(path.join(root, relative), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`SNAPSHOT_CORPUS_FILE_MISSING: ${path.join(root, relative)}`);
    }
    throw error;
  }
  // CRLF-safe load: a Windows checkout may materialize the committed LF bytes
  // as CRLF (core.autocrlf). The captured documents are LF; normalize back so
  // content hashes stay byte-stable regardless of checkout platform.
  return text.replace(/\r\n/g, '\n');
}

export function createCorpusAccess(root) {
  const manifestText = readCorpusBytes(root, 'manifest.json');
  let MANIFEST;
  try {
    MANIFEST = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`SNAPSHOT_CORPUS_JSON_INVALID: manifest.json (${error.message})`);
  }
  const corpusFile = relative => {
    const text = readCorpusBytes(root, relative);
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`SNAPSHOT_CORPUS_JSON_INVALID: ${relative} (${error.message})`);
    }
  };
  // Product bytes are verified against the manifest's sourcePayloadHash —
  // the ORIGINAL factory payload_hash (sha256 of the canonical payload), not
  // the pretty-printed file bytes. sha256Hex(parsed) reproduces it, so the
  // check survives review-friendly re-serialization.
  const productFile = (node, schema, ordinal) => {
    const entry = MANIFEST.products.find(product => product.nodeId === node
      && product.schemaId === schema && product.ordinal === ordinal);
    if (!entry) {
      throw new Error(`SNAPSHOT_CORPUS_PRODUCT_MISSING: ${node}/${schema}#${ordinal}`);
    }
    const payload = corpusFile(entry.file);
    const digest = sha256Hex(payload);
    if (digest !== entry.sourcePayloadHash) {
      throw new Error(
        `SNAPSHOT_CORPUS_DRIFT: product ${entry.file} hashes ${digest}, corpus says ${entry.sourcePayloadHash}`,
      );
    }
    return payload;
  };
  const documentFor = sourcePath => {
    const entry = MANIFEST.documents.find(doc => doc.source === sourcePath);
    if (!entry) throw new Error(`SNAPSHOT_CORPUS_DOCUMENT_MISSING: ${sourcePath}`);
    const text = readCorpusBytes(root, entry.file);
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');
    if (digest !== entry.contentHash) {
      throw new Error(
        `SNAPSHOT_CORPUS_DRIFT: document ${sourcePath} (${entry.file}) hashes ${digest}, corpus says ${entry.contentHash}`,
      );
    }
    return text;
  };
  return { root, manifest: MANIFEST, corpusFile, productFile, documentFor };
}

const corpusAccess = createCorpusAccess(CORPUS_ROOT);
const { corpusFile, productFile, documentFor } = corpusAccess;
const MANIFEST = corpusAccess.manifest;

// Artifact specs joined from the corpus: manifest.artifacts carries
// type/code/title/path; the node's bundle products carry each artifact's
// FINAL accepted contentHash (the artifact-ref products freeze creation-time
// bytes, which for artifact:3 / artifact:17 are uncaptured intermediates —
// the replay writes final bytes, so it must also state final hashes).
function finalContentHashes(node) {
  const bundles = MANIFEST.products
    .filter(product => product.nodeId === node && /formalization-.*-bundle\.v1$/.test(product.schemaId))
    .sort((a, b) => a.ordinal - b.ordinal);
  const hashes = new Map();
  for (const bundle of bundles) {
    const payload = corpusFile(bundle.file);
    for (const artifact of payload.artifacts || []) {
      hashes.set(Number(artifact.artifactId), artifact.contentHash);
    }
  }
  return hashes;
}

function artifactSpec(node, artifactId, finalHashes) {
  const refEntry = MANIFEST.products.find(product => product.nodeId === node
    && product.schemaId === 'factory.artifact-ref.v1'
    && product.productKey === `artifact:${artifactId}`);
  if (!refEntry) {
    throw new Error(`SNAPSHOT_CORPUS_ARTIFACT_REF_MISSING: ${node}#${artifactId}`);
  }
  const ref = corpusFile(refEntry.file);
  // manifest.artifacts is ordered by artifact id (harvested ORDER BY id), so
  // the artifactId indexes it directly.
  const meta = MANIFEST.artifacts[artifactId - 1];
  if (!meta) throw new Error(`SNAPSHOT_CORPUS_ARTIFACT_MISSING: id=${artifactId}`);
  return {
    id: ref.artifactId,
    type: meta.type,
    code: meta.code,
    title: meta.title,
    path: meta.path,
    contentHash: finalHashes.get(Number(ref.artifactId)) || ref.contentHash,
  };
}

// --- captured instrumented-call tape (artifact_traces ids 1..29, in order) ---
// Hand-assembled from the frozen run DB (SELECT ... WHERE id<=29 ORDER BY id):
// each tuple is [sourceArtifactId, targetArtifactId, linkType].
const TRACES = [
  // define-product-contract
  [2, 1, 'derived_from'],
  [3, 2, 'derived_from'], [4, 2, 'derived_from'], [5, 2, 'derived_from'],
  [6, 2, 'derived_from'], [7, 2, 'derived_from'], [8, 2, 'derived_from'],
  [9, 2, 'derived_from'],
  // model-use-cases
  [10, 2, 'derived_from'], [10, 3, 'covers'], [10, 4, 'covers'], [10, 5, 'covers'],
  [11, 2, 'derived_from'], [11, 6, 'covers'],
  // define-acceptance-contract
  [12, 10, 'derived_from'], [12, 3, 'derived_from'], [12, 9, 'derived_from'],
  [13, 10, 'derived_from'], [13, 4, 'derived_from'],
  [14, 10, 'derived_from'], [14, 5, 'derived_from'],
  [15, 10, 'derived_from'], [15, 5, 'derived_from'],
  [16, 11, 'derived_from'], [16, 6, 'derived_from'], [16, 7, 'derived_from'],
  [16, 8, 'derived_from'], [16, 9, 'derived_from'],
  // define-architecture-contract (SRS -> PRD)
  [17, 2, 'derived_from'],
];

function tracesBetween(first, last) {
  return TRACES.slice(first - 1, last);
}

// The captured artifact ids are deterministic in a fresh DB replayed in tape
// order; handlers assert them (mutual-consistency oracle).
const CAPTURED_FIRST_TRACE_ID_PER_CELL = {
  'define-product-contract': 1,
  'model-use-cases': 9,
  'define-acceptance-contract': 15,
  'define-architecture-contract': 29,
};

function metaOf(task) {
  return typeof task.metadata === 'string'
    ? JSON.parse(task.metadata || '{}')
    : (task.metadata || {});
}

function findObject(value, predicate, seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && predicate(value)) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findObject(child, predicate, seen);
    if (found) return found;
  }
  return null;
}

function git(repoPath, args) {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.trim()}`);
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Discovery (captured)
// ---------------------------------------------------------------------------

const PROPOSAL = productFile('produce-proposal', 'factory.discovery-proposal.v1', 1);
const READINESS = productFile('assess-readiness', 'factory.discovery-readiness-assessment.v2', 1);

// The CURRENT factory requires metadata.brief_payload on brief
// artifact_create (src/validators/brief.ts). This validation post-dates the
// stage-11 capture — the frozen run's brief artifact carries no brief_payload
// (the requirement did not exist at capture commit 8f367b2a). The tape
// derives the payload STRICTLY from captured values: decision is the
// captured proposal's recommended_outcome, reasoning is the captured
// proposal's rationale text (real NN output), completeness mirrors the
// captured readiness assessment ('ready', confidence 0.95 -> 'high'),
// complexity comes from the captured proposal's observed context
// ('complexity=XS, type=web-app'). No invented prose.
function derivedBriefPayload(task) {
  return {
    classification: 'product',
    complexity: { tshirt: 'XS', risk_triggers: [] },
    decision: PROPOSAL.recommended_outcome,
    reasoning: PROPOSAL.rationale,
    affected_projects: [task.project_id || 1],
    topology_hint: 'sequence',
    scaffold_artifacts: [],
    shared_mutation_risk: false,
    completeness: READINESS.overall_readiness === 'ready' ? 'high' : 'medium',
    degraded: false,
  };
}

// ADR-090 (CC-IC-2) constraint-disposition gate: the CURRENT factory also
// requires brief metadata to dispose every constraint-register entry in the
// strict v2 grammar, pinned to the register digest (this too post-dates the
// capture — the same derived-metadata discipline as brief_payload above).
// The register is recomputed from the CAPTURED proposal payload the runtime
// formalization case embeds (the tape replays those bytes, and the readiness
// handler above already proves the runtime digest equals the captured one).
// Dispositions are derived strictly from captured material:
//   - open-question entries (the captured proposal's unknowns) are
//     `resolved` citing the captured readiness assessment's
//     unknowns_manageability dimension — the real NN product that adjudicated
//     them (fail-closed: the dimension must exist and be 'sufficient');
//   - every other entry is `accepted` — the captured FR/SRS work carries it.
// No invented prose; v2 `waived` is typed-unavailable and never used.
function constraintRegisterOf(task) {
  const formalizationCase = findObject(
    metaOf(task).process_node_input ?? metaOf(task),
    value => value.schemaVersion === 'factory.formalization-case.v1',
  );
  if (!formalizationCase) return null;
  const payload = formalizationCase.discoveryProposalPayload ?? {};
  return buildOrderConstraintRegisterV2({
    drafts: payload.order_constraints,
    unknowns: payload.unknowns,
    injections: [{
      table: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE,
      tableRef: RUNNABLE_LOCAL_OBLIGATION_INJECTION_TABLE_REF,
    }],
  });
}

function derivedConstraintDispositions(task) {
  const register = constraintRegisterOf(task);
  if (!register) return null;
  const manageability = READINESS.dimension_assessments?.unknowns_manageability;
  if (!manageability || manageability.status !== 'sufficient') {
    throw new Error(
      'SNAPSHOT_DERIVED_DISPOSITION_INVALID: captured readiness assessment has no '
      + 'sufficient unknowns_manageability dimension to cite as open-question resolution evidence',
    );
  }
  const dispositions = {};
  for (const entry of register.constraints) {
    dispositions[entry.id] = entry.kind === 'open-question'
      ? {
        disposition: 'resolved',
        evidenceRef: 'factory.discovery-readiness-assessment.v2:unknowns_manageability',
      }
      : { disposition: 'accepted' };
  }
  return {
    constraint_dispositions: dispositions,
    constraint_dispositions_register_digest: register.registerDigest,
  };
}

// The ADR-088/090 acceptance coverage relay: the CURRENT factory requires the AC
// work to carry covered_constraint_ids for every non-waived register entry
// (on v2 that is ALL of them — resolved/deferred stay obligations). This too
// postdates the capture; the derivation round-trips through authority — the
// ids are read back from the ACCEPTED BRIEF's dispositions (the same
// worker-visible source golden-path uses), never invented locally.
// Fail-closed by construction: before the define-product-contract cell has
// sealed and accepted the brief there is no disposition source, and this
// throws SNAPSHOT_DERIVED_COVERAGE_INVALID — the tape cannot run the
// acceptance/architecture cells ahead of their sealed predecessor, and it
// never invents the predecessor material (no decoy adoption).
export async function coveredConstraintIdsFromBrief(client, epicId) {
  const briefs = await actions.findAcceptedArtifacts(client, epicId, 'brief');
  for (const brief of briefs) {
    let metadata = brief.metadata;
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
    }
    const dispositions = metadata?.constraint_dispositions;
    if (!dispositions || typeof dispositions !== 'object') continue;
    return Object.entries(dispositions)
      .filter(([, value]) => value && value.disposition !== 'waived')
      .map(([id]) => id)
      .sort();
  }
  throw new Error('SNAPSHOT_DERIVED_COVERAGE_INVALID: accepted brief carries no constraint dispositions');
}

// The SRS §D2 back-edge (also postdates the capture): the union of the §D2
// stanzas' covered_constraint_ids must cover the register. Unlike the AC
// relay (artifact metadata), this gate reads the SRS FILE BYTES, so the
// replayed SRS document is the captured text PLUS exactly one derived stanza
// field — the golden-path relay shape (full non-waived id list on the FIRST
// stanza). Everything else in the document stays byte-exact; the derivation
// is asserted (derived text minus the injected line === captured text).
// Knock-on effects, all documented in the test:
//   - artifact 17's contentHash is the DERIVED document hash (the factory
//     hashes the file server-side; a caller digest is never trusted);
//   - the architecture bundle therefore carries the derived hash for
//     artifact 17 and is compared by parsed content modulo that one hash.
export function deriveArchitectureSrsText(capturedText, coveredIds) {
  if (!Array.isArray(coveredIds) || coveredIds.length === 0) {
    throw new Error('SNAPSHOT_DERIVED_SRS_INVALID: no covered constraint ids to relay');
  }
  const firstStanza = capturedText.indexOf('\n- ac:');
  if (firstStanza < 0) {
    throw new Error('SNAPSHOT_DERIVED_SRS_INVALID: captured SRS has no §D2 stanza');
  }
  let stanzaEnd = capturedText.indexOf('\n- ac:', firstStanza + 1);
  if (stanzaEnd < 0) stanzaEnd = capturedText.indexOf('```', firstStanza);
  if (stanzaEnd < 0) {
    throw new Error('SNAPSHOT_DERIVED_SRS_INVALID: cannot locate the end of the first §D2 stanza');
  }
  const injected = `\n  covered_constraint_ids: ${coveredIds.join(', ')}`;
  return capturedText.slice(0, stanzaEnd) + injected + capturedText.slice(stanzaEnd);
}

export function stripDerivedSrsCoverageLine(text) {
  // The exact inverse of the injection above — used by fail-closed checks to
  // prove the derived document is the captured document plus ONLY that line.
  const stripped = text.replace(
    /\n  covered_constraint_ids: ord-c-\d{3,}(?:, ord-c-\d{3,})*\n/,
    '\n',
  );
  if (stripped === text) {
    throw new Error('SNAPSHOT_DERIVED_SRS_INVALID: derived line not found to strip');
  }
  return stripped;
}

const discoveryProposal = async ({ client, prompt }) => {
  await actions.submitProduct(client, 'factory.discovery-proposal.v1', PROPOSAL);
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'snapshot replay: captured discovery proposal (recommended_outcome=go)');
};

const discoveryReadiness = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  // Fail-closed input check: the captured readiness body references the
  // captured proposal digest. The runtime proposal must be the same bytes.
  let runtimeDigest = null;
  const pni = meta.process_node_input;
  if (pni?.bindings?.items) {
    for (const item of pni.bindings.items) {
      const p = (item.products || []).find(x => x.schemaId === 'factory.discovery-proposal.v1');
      if (p) { runtimeDigest = p.digest; break; }
    }
  }
  if (runtimeDigest && runtimeDigest !== READINESS.proposal_content_hash) {
    throw new Error(
      `SNAPSHOT_REPLAY_DRIFT: runtime proposal digest ${runtimeDigest} != captured `
      + `${READINESS.proposal_content_hash} — the proposal replay is not byte-exact`,
    );
  }
  await actions.submitProduct(
    client, 'factory.discovery-readiness-assessment.v2', READINESS,
  );
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'snapshot replay: captured readiness assessment (ready)');
};

// ---------------------------------------------------------------------------
// Formalization artifact cells (captured; files + artifact_create + trace_add)
// ---------------------------------------------------------------------------

async function replayArtifactCell({ client, task, prompt, repoPath }, node, firstArtifact, lastArtifact, firstTrace, lastTrace, options = {}) {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const finalHashes = finalContentHashes(node);
  const specs = [];
  for (let id = firstArtifact; id <= lastArtifact; id += 1) {
    specs.push(artifactSpec(node, id, finalHashes));
  }

  // Write the captured document bytes (idempotent for anchor-shared files),
  // then create artifacts in captured id order. documentFor is the fail-closed
  // read: it already verified the bytes hash to the captured contentHash.
  // EXCEPTION (documented derivation, see deriveArchitectureSrsText): the
  // SRS gets exactly one derived §D2 stanza field; the write check proves
  // derived-minus-line === captured bytes instead.
  const written = new Set();
  for (const spec of specs) {
    const filePath = spec.path.split('#')[0];
    if (repoPath && !written.has(filePath)) {
      const source = `artifacts/requirements/${filePath.replace(/^docs\/requirements\//, '')}`;
      const capturedBody = documentFor(source);
      let body = capturedBody;
      if (options.srsCoverage && spec.type === 'SRS') {
        body = deriveArchitectureSrsText(capturedBody, options.srsCoverage);
        if (stripDerivedSrsCoverageLine(body) !== capturedBody) {
          throw new Error(`SNAPSHOT_DERIVED_SRS_DRIFT: derived SRS for ${source} is not captured-bytes-plus-one-line`);
        }
      }
      actions.writeFile(repoPath, filePath, body);
      written.add(filePath);
    }
  }
  for (const spec of specs) {
    const created = await client.callJson('artifact_create', {
      project_id: projectId,
      epic_id: epicId,
      type: spec.type,
      code: spec.code,
      title: spec.title,
      path: spec.path,
      status: 'draft',
      content_hash: spec.contentHash,
      project_repository_id: 1,
      ...(spec.type === 'brief' ? {
        metadata: {
          brief_payload: derivedBriefPayload(task),
          ...(derivedConstraintDispositions(task) ?? {}),
        },
      } : {}),
      ...(options.acCoverage && spec.type === 'AC' ? { metadata: { covered_constraint_ids: options.acCoverage } } : {}),
    });
    const createdId = created.artifact?.id ?? created.id;
    if (Number(createdId) !== spec.id) {
      throw new Error(
        `SNAPSHOT_REPLAY_DRIFT: artifact ${spec.code} created with id ${createdId}, `
        + `captured id ${spec.id} — replay order diverged from the tape`,
      );
    }
  }

  // Traces in captured id order. The factory assigns sequential ids; the
  // captured cell-local first id must match (mutual-consistency oracle).
  const traces = tracesBetween(firstTrace, lastTrace);
  const expectedFirstTraceId = CAPTURED_FIRST_TRACE_ID_PER_CELL[node];
  for (let index = 0; index < traces.length; index += 1) {
    const [sourceId, targetId, linkType] = traces[index];
    const result = await actions.addTrace(client, sourceId, targetId, linkType);
    const traceId = Number(result.trace?.id ?? result.id ?? -1);
    const expectedTraceId = expectedFirstTraceId + index;
    if (traceId !== expectedTraceId) {
      throw new Error(
        `SNAPSHOT_REPLAY_DRIFT: trace [${sourceId}->${targetId} ${linkType}] got id `
        + `${traceId}, captured id ${expectedTraceId} — replay order diverged`,
      );
    }
  }

  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `snapshot replay: ${node} — ${specs.length} artifacts, ${traces.length} traces from captured tape`);
}

const formalizationProductContract = ctx => replayArtifactCell(
  ctx, 'define-product-contract', 1, 9, 1, 8,
);
const formalizationUseCases = ctx => replayArtifactCell(
  ctx, 'model-use-cases', 10, 11, 9, 14,
);
const formalizationAcceptance = async ctx => replayArtifactCell(
  ctx, 'define-acceptance-contract', 12, 16, 15, 28,
  // ADR-090 coverage relay (postdates the capture): the derived
  // covered_constraint_ids read back from the accepted brief's dispositions.
  { acCoverage: await coveredConstraintIdsFromBrief(ctx.client, ctx.task.epic_id || 1) },
);
// Architecture replays only the ACCEPTED (v2) round — see file header.
// The SRS bytes carry the derived §D2 coverage relay (documented deviation:
// the coverage gate postdates the capture), so the runtime bundle's
// artifact-17 contentHash is the DERIVED hash. Everything else byte-exact.
const formalizationArchitecture = async ctx => replayArtifactCell(
  ctx, 'define-architecture-contract', 17, 17, 29, 29,
  { srsCoverage: await coveredConstraintIdsFromBrief(ctx.client, ctx.task.epic_id || 1) },
);

// ---------------------------------------------------------------------------
// Reconciliation (captured products)
// ---------------------------------------------------------------------------

const RECONCILIATION = productFile('reconcile-what', 'factory.formalization-reconciliation-report.v1', 1);

const reconciliationAuthor = async ({ client, prompt }) => {
  await actions.submitProduct(
    client, 'factory.formalization-reconciliation-report.v1', RECONCILIATION,
  );
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'snapshot replay: captured reconciliation report (reconciled)');
};

// ---------------------------------------------------------------------------
// Reviewers (captured verdicts; material verified byte-exact, subject ref
// rebound to the CURRENT runtime candidate — documented deviation)
// ---------------------------------------------------------------------------
//
// Why the rebinding: the captured verdict's subject_candidate_set_ref embeds
// the material hash of the CAPTURED author revision. Current production
// (ADR-053 cutover) seals the submission-validation-receipt into the same
// Workplace production revision (the shift-left worker_done gate postdates
// the capture), so the runtime revision/candidate ref is STRUCTURALLY
// different from the captured one even when the replayed material is
// byte-exact. Presenting the stale captured ref would be exactly the
// stale-authority presentation ADR-053 forbids. The tape therefore:
//   1. verifies the runtime author candidate's product members are
//      byte-exact against the corpus (per-schema digest multiset equality —
//      a MATERIAL oracle, stronger than comparing a derived ref string);
//   2. submits the captured verdict with ONLY subject_candidate_set_ref
//      rebound to the runtime candidate.
// The test's product-hash assertion handles this field with the same
// modulo-subject-ref parsed-content oracle (see snapshot-reach-development).

function verifyAuthorMaterialByteExact(node, candidate, options = {}) {
  const expected = MANIFEST.products
    .filter(product => product.nodeId === node)
    .filter(product => product.schemaId !== 'factory.artifact-ref.v1'
      && !product.schemaId.includes('review-verdict'))
    // The architecture node carries TWO captured bundles (rejected v1 round +
    // accepted v2 round); only the ACCEPTED round is replayed, so the v2
    // bundle is the expected member.
    .filter(product => !(options.bundleOrdinal
      && product.schemaId === 'factory.formalization-architecture-bundle.v1'
      && product.ordinal !== options.bundleOrdinal));
  const groupBySchema = products => {
    const grouped = new Map();
    for (const product of products) {
      const list = grouped.get(product.schemaId) || [];
      list.push(product);
      grouped.set(product.schemaId, list);
    }
    return grouped;
  };
  const expectedBySchema = groupBySchema(expected.map(p => ({ schemaId: p.schemaId, digest: p.sourcePayloadHash })));
  const actualBySchema = groupBySchema((candidate.product_refs || []).map(p => ({ schemaId: p.schemaId, digest: p.digest })));
  for (const [schema, expectedList] of expectedBySchema) {
    const actualList = actualBySchema.get(schema) || [];
    const expectedSorted = expectedList.map(e => e.digest).sort();
    const actualSorted = actualList.map(a => a.digest).sort();
    if (actualSorted.length !== expectedSorted.length
      || actualSorted.some((digest, index) => digest !== expectedSorted[index])) {
      if (options.srsBundleModuloDerivedHash
        && schema === 'factory.formalization-architecture-bundle.v1'
        && actualSorted.length === expectedSorted.length) {
        // The architecture bundle carries the DERIVED SRS contentHash for
        // artifact 17 (see deriveArchitectureSrsText). Digest equality is
        // impossible by construction; the parsed-content oracle below
        // verifies it precisely instead of comparing the derived digest.
        continue;
      }
      throw new Error(
        `SNAPSHOT_REPLAY_DRIFT: author material for ${node}/${schema} is not byte-exact `
        + `— runtime digests [${actualSorted.join(',')}] != corpus [${expectedSorted.join(',')}]`,
      );
    }
  }
  // No foreign material: every runtime member schema must be a captured schema.
  for (const schema of actualBySchema.keys()) {
    if (!expectedBySchema.has(schema)) {
      throw new Error(
        `SNAPSHOT_REPLAY_DRIFT: author candidate for ${node} carries non-captured material ${schema}`,
      );
    }
  }
}

// Parsed-content oracle for the architecture bundle: byte-equal to the
// captured bundle modulo artifact 17's contentHash, which must be exactly
// the hash of the derived SRS document (captured bytes + one §D2 stanza
// field). Everything else — artifact ids, types, statuses, traces — must be
// byte-exact.
async function verifyArchitectureBundleParsed(client, node, candidate, task) {
  const bundleRef = (candidate.product_refs || []).find(
    p => p.schemaId === 'factory.formalization-architecture-bundle.v1',
  );
  if (!bundleRef) throw new Error('SNAPSHOT_REPLAY_DRIFT: architecture bundle missing from author candidate');
  const read = await client.callJson('product_read', {
    schema_id: bundleRef.schemaId, ref: bundleRef.ref, digest: bundleRef.digest,
  });
  const runtime = read.content || read;
  const corpusEntry = MANIFEST.products.find(
    product => product.nodeId === node
      && product.schemaId === 'factory.formalization-architecture-bundle.v1'
      && product.ordinal === 2,
  );
  const captured = corpusFile(corpusEntry.file);
  // The covered ids round-trip through authority: read back from the ACCEPTED
  // brief's dispositions (the reviewer task metadata carries no formalization
  // case envelope — the same worker-visible source the author used).
  const coveredIds = await coveredConstraintIdsFromBrief(client, task.epic_id || 1);
  if (!Array.isArray(coveredIds) || coveredIds.length === 0) {
    throw new Error('SNAPSHOT_DERIVED_SRS_INVALID: no covered constraint ids on the accepted brief');
  }
  const capturedSrs = documentFor('artifacts/requirements/REQ-001/12-SRS.md');
  const derivedSrsHash = createHash('sha256')
    .update(deriveArchitectureSrsText(capturedSrs, coveredIds), 'utf8').digest('hex');
  const runtimeArtifacts = runtime.artifacts || [];
  const capturedArtifacts = captured.artifacts || [];
  if (runtimeArtifacts.length !== capturedArtifacts.length) {
    throw new Error(
      `SNAPSHOT_REPLAY_DRIFT: architecture bundle artifact count ${runtimeArtifacts.length} != captured ${capturedArtifacts.length}`,
    );
  }
  for (let index = 0; index < capturedArtifacts.length; index += 1) {
    const runtimeArtifact = runtimeArtifacts[index];
    const capturedArtifact = capturedArtifacts[index];
    const { contentHash: runtimeHash, ...runtimeRest } = runtimeArtifact;
    const { contentHash: capturedHash, ...capturedRest } = capturedArtifact;
    if (JSON.stringify(runtimeRest) !== JSON.stringify(capturedRest)) {
      throw new Error(
        `SNAPSHOT_REPLAY_DRIFT: architecture bundle artifact ${capturedArtifact.artifactId} differs beyond the contentHash`,
      );
    }
    if (Number(capturedArtifact.artifactId) === 17) {
      if (runtimeHash !== derivedSrsHash) {
        throw new Error(
          `SNAPSHOT_REPLAY_DRIFT: artifact 17 contentHash ${runtimeHash} != derived SRS hash ${derivedSrsHash}`,
        );
      }
    } else if (runtimeHash !== capturedHash) {
      throw new Error(
        `SNAPSHOT_REPLAY_DRIFT: architecture bundle artifact ${capturedArtifact.artifactId} contentHash ${runtimeHash} != captured ${capturedHash}`,
      );
    }
  }
  const { artifacts: _ra, ...runtimeRestBundle } = runtime;
  const { artifacts: _ca, ...capturedRestBundle } = captured;
  if (JSON.stringify(runtimeRestBundle) !== JSON.stringify(capturedRestBundle)) {
    throw new Error('SNAPSHOT_REPLAY_DRIFT: architecture bundle differs beyond artifact contentHashes');
  }
}

function capturedReviewer(verdictNode, schema = 'factory.review-verdict.v1', ordinal = 1, options = {}) {
  return async ({ client, task, prompt }) => {
    const verdict = productFile(verdictNode, schema, ordinal);
    const workplaceRef = metaOf(task).workplace_ref;
    if (!workplaceRef) throw new Error('SNAPSHOT_WORKPLACE_REF_MISSING');
    const candidate = await actions.readAuthorCandidate(client, workplaceRef);
    verifyAuthorMaterialByteExact(verdictNode, candidate, options);
    if (options.srsBundleModuloDerivedHash) {
      await verifyArchitectureBundleParsed(client, verdictNode, candidate, task);
    }
    await actions.submitProduct(client, schema, {
      ...verdict,
      subject_candidate_set_ref: candidate.candidate_set_ref,
    });
    await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
      `snapshot replay: captured review verdict (${verdict.verdict}), subject rebound to the current candidate`);
  };
}

// ---------------------------------------------------------------------------
// Development planner (captured 3-round repair loop)
// ---------------------------------------------------------------------------

const PLANNER_PROPOSALS = [
  productFile('plan-task-graph', 'factory.development-task-graph-proposal.v1', 1),
  productFile('plan-task-graph', 'factory.development-task-graph-proposal.v1', 2),
  productFile('plan-task-graph', 'factory.development-task-graph-proposal.v1', 3),
];

// ADR-088 (CC-GAP-6) planner grammar relay (postdates the capture): the
// CURRENT proposal contract requires per-item acceptanceCriterionKeys —
// atomic `${artifactId}:${code}` criterion identities — while the capture
// predates the relay and references whole AC artifacts by id
// (acceptanceCriterionIds; artifacts 12-16 = AC-1..AC-5, one criterion per
// accepted AC artifact). Same derived-metadata discipline as the SRS §D2
// relay above: the substitution is derived STRICTLY from the RUNTIME frozen
// development case carried by the planner task itself — each captured
// artifact id maps to the exact criterion key of that artifact in the case.
// Fail-closed: an id absent from the case, a null/missing criterion code, or
// an item referencing nothing is a typed SNAPSHOT_DERIVED_PLANNER_KEYS_*
// error — the tape never invents criterion coverage, and it cannot run the
// planner before the acceptance cell sealed the AC artifacts (the case would
// not exist). Everything else in the captured proposal stays byte-exact;
// the reach test verifies this substitution with a dedicated parsed-content
// oracle (see (c4) in snapshot-reach-development.test.mjs).
export function plannerProposalForCurrentGrammar(capturedProposal, task) {
  const developmentCase = findObject(
    metaOf(task),
    value => value.schemaVersion === 'factory.development-case.v1',
  );
  if (!developmentCase || !Array.isArray(developmentCase.acceptanceCriteria)) {
    throw new Error(
      'SNAPSHOT_DERIVED_PLANNER_KEYS_INVALID: planner task metadata carries no frozen development case',
    );
  }
  const keyByArtifactId = new Map();
  for (const criterion of developmentCase.acceptanceCriteria) {
    if (!Number.isInteger(criterion?.artifactId)) continue;
    if (typeof criterion?.code !== 'string' || criterion.code.length === 0) {
      throw new Error(
        `SNAPSHOT_DERIVED_PLANNER_KEYS_INVALID: criterion of artifact ${criterion.artifactId} has no code (a null-code criterion cannot be referenced by the current proposal grammar)`,
      );
    }
    keyByArtifactId.set(criterion.artifactId, `${criterion.artifactId}:${criterion.code}`);
  }
  if (keyByArtifactId.size === 0) {
    throw new Error(
      'SNAPSHOT_DERIVED_PLANNER_KEYS_INVALID: frozen case carries no acceptance criteria',
    );
  }
  const translateItem = item => {
    const ids = item.acceptanceCriterionIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error(
        `SNAPSHOT_DERIVED_PLANNER_KEYS_INVALID: captured item ${item.key} references no acceptance artifacts`,
      );
    }
    const keys = [];
    for (const id of ids) {
      const key = keyByArtifactId.get(Number(id));
      if (!key) {
        throw new Error(
          `SNAPSHOT_DERIVED_PLANNER_KEYS_INVALID: captured artifact id ${id} (item ${item.key}) is not an accepted criterion of the frozen case`,
        );
      }
      keys.push(key);
    }
    const { acceptanceCriterionIds: _capturedIds, ...rest } = item;
    return { ...rest, acceptanceCriterionKeys: [...new Set(keys)].sort() };
  };
  return {
    ...capturedProposal,
    implementationItems: capturedProposal.implementationItems.map(translateItem),
    verificationItems: capturedProposal.verificationItems.map(translateItem),
  };
}

const developmentPlan = async ({ client, task, prompt, attempt }) => {
  // Captured loop: proposal #1 gate-rejected, #2 gate-rejected, #3 accepted.
  // Attempt->ordinal mapping cycles so a durable lease-recovery attempt can
  // never strand the cell; the gate still only accepts proposal #3's bytes.
  const ordinal = ((attempt - 1) % PLANNER_PROPOSALS.length) + 1;
  await actions.submitProduct(
    client, 'factory.development-task-graph-proposal.v1',
    plannerProposalForCurrentGrammar(PLANNER_PROPOSALS[ordinal - 1], task),
  );
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `snapshot replay: captured planner proposal #${ordinal} (attempt ${attempt})`);
};

// ---------------------------------------------------------------------------
// Development tail (deterministic scripted logic — NOT captured material).
// The stage-11 run was paused mid-implementation; implementation products
// embed run-local git SHAs, so byte replay is impossible by construction.
// The tail exists only so the lifecycle terminates (exit 0) after the tape
// has crossed into solution-development. No content assertions are made
// against the corpus for these cells.
// ---------------------------------------------------------------------------

const developmentImplement = async ({ client, task, prompt, repoPath, desk }) => {
  const meta = metaOf(task);
  const item = meta.cell_input_item || findObject(meta.process_node_input, x => x.kind === 'implementation');
  if (!item?.key) throw new Error('implementation work item not found');
  const workItemKey = String(item.key);
  const safe = workItemKey.replace(/[^a-zA-Z0-9._-]/g, '-');

  // Write inside the item's own declared change scope (deterministic).
  const scopes = (item.changeScopes || []).filter(scope => scope.endsWith('/'));
  const scopeDir = scopes[0] || 'src/';
  const filePath = `${scopeDir}${safe}.ts`;
  const branch = desk?.branch || `snapshot-replay-${safe}-${String(prompt.task_id)}`;
  const integrationBranch = desk?.integrationBranch || 'dev';
  const baseCommit = desk?.baseCommit || git(repoPath, ['rev-parse', `refs/heads/${integrationBranch}`]);
  if (!desk) {
    git(repoPath, ['checkout', '-B', branch, integrationBranch]);
  }
  actions.writeFile(repoPath, filePath,
    `// snapshot-replay deterministic implementation for ${workItemKey}\n`
    + `export const ${safe.replace(/[^a-zA-Z0-9_]/g, '_')} = true;\n`);
  git(repoPath, ['add', filePath]);
  git(repoPath, ['commit', '-m', `snapshot-replay: implement ${workItemKey}`]);
  const commitSha = git(repoPath, ['rev-parse', 'HEAD']);
  const treeSha = git(repoPath, ['rev-parse', `${commitSha}^{tree}`]);

  await actions.submitProduct(client, 'factory.development-implementation-result.v1', {
    workItemKey,
    terminalStatus: 'complete',
    source: { branch, commitSha, workItemKey },
    snapshot: { commitSha, treeSha, files: [filePath], changedFiles: [filePath] },
    repository: {
      projectRepositoryId: Number(item.projectRepositoryId || task.project_repository_id || 1),
      integrationBranch,
      baseCommit,
      name: 'stage11-replay-repo',
    },
    buildProducts: [],
    readiness: {
      kind: 'static',
      commands: {
        installCommand: null,
        testCommand: 'node -e "process.exit(0)"',
      },
    },
    reasonCodes: [],
  });
  if (!desk) {
    git(repoPath, ['checkout', integrationBranch]);
  }
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `snapshot-replay tail: implemented ${workItemKey}`);
};

const developmentReview = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const wpRef = meta.workplace_ref;
  const cand = await actions.readAuthorCandidate(client, wpRef);
  const implRef = (cand.product_refs || []).find(
    p => p.schemaId === 'factory.development-implementation-result.v1',
  );
  if (!implRef) throw new Error('implementation result missing from author CandidateSet');
  const read = await client.callJson('product_read', {
    schema_id: implRef.schemaId, ref: implRef.ref, digest: implRef.digest,
  });
  const impl = read.content || read;
  await actions.submitProduct(client, 'factory.development-review-verdict.v1', {
    subject_candidate_set_ref: cand.candidate_set_ref,
    verdict: 'approved',
    findings: [],
    workItemKey: impl.workItemKey,
    reviewedCandidate: {
      sourceCommit: impl.source?.commitSha,
      sourceTree: impl.snapshot?.treeSha,
    },
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `snapshot-replay tail: review approved ${impl.workItemKey}`);
};

const developmentVerify = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const item = meta.cell_input_item || findObject(meta.process_node_input, x => x.kind === 'verification');
  if (!item?.key) throw new Error('verification work item not found');
  const candidate = findObject(
    meta.process_node_input ?? meta,
    value => value.schemaVersion === 'factory.integrated-release-candidate.v1'
      && typeof value.candidateHash === 'string',
  );
  if (!candidate) throw new Error('frozen candidate not found in verification input');
  // ADR-088 (CC-GAP-6) grammar relay (postdates the capture): the current
  // verification work item and the v2 evidence product speak the ATOMIC
  // criterion key (`artifactId:code`), not the captured whole-artifact id.
  // The key is read from the runtime graph item the task was materialized
  // from — fail-closed on shape; never a legacy-id fallback that could
  // silently verify the wrong criterion.
  const criterionKey = item.acceptanceCriterionKeys?.[0];
  if (typeof criterionKey !== 'string' || !/^[1-9]\d*:.+$/.test(criterionKey)) {
    throw new Error(
      `verification item ${item.key} carries no atomic acceptance criterion key`,
    );
  }
  const acId = Number(criterionKey.slice(0, criterionKey.indexOf(':')));
  const acResp = await client.callJson('artifact_get', { id: acId });
  const ac = acResp.artifact || acResp;
  const acceptedCriterionHash = ac.accepted_hash || ac.content_hash;
  if (!acceptedCriterionHash) throw new Error(`accepted hash missing for AC ${acId}`);
  const evidenceBody = {
    verificationItemKey: item.key,
    acceptanceCriterionKey: criterionKey,
    candidateHash: candidate.candidateHash,
    result: 'passed',
  };
  const evidenceHash = createHash('sha256').update(JSON.stringify(evidenceBody)).digest('hex');
  await actions.submitProduct(client, 'factory.candidate-verification-evidence-product.v2', {
    schemaVersion: 'factory.candidate-verification-evidence-product.v2',
    verificationItemKey: item.key,
    acceptanceCriterionKey: criterionKey,
    acceptedCriterionHash,
    candidateHash: candidate.candidateHash,
    outcome: 'passed',
    evidence: {
      summary: `snapshot-replay verification passed for ${item.key}`,
      observations: [`evidence digest ${evidenceHash}`],
      limitations: [],
    },
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    `snapshot-replay tail: verified ${item.key}`);
};

const developmentReadiness = async ({ client, task, prompt }) => {
  const meta = metaOf(task);
  const sourceRef = findObject(
    meta.process_node_input ?? meta,
    value => value.schema === 'factory.integrated-source-candidate.v1'
      && typeof value.ref === 'string' && typeof value.hash === 'string',
  );
  if (!sourceRef) throw new Error('integrated source ProductRef not found');
  await actions.submitProduct(client, 'factory.development-readiness-manifest.v1', {
    schemaVersion: 'factory.development-readiness-manifest.v1',
    sourceCandidate: sourceRef,
    targets: [{
      key: 'primary',
      readiness: {
        kind: 'static',
        commands: { installCommand: null, testCommand: 'node -e "process.exit(0)"' },
      },
    }],
  });
  await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
    'snapshot-replay tail: certified product readiness');
};

export const scenarios = {
  // Discovery — captured
  [`${DISC}/produce-proposal/author/singleton`]: discoveryProposal,
  [`${DISC}/assess-readiness/author/singleton`]: discoveryReadiness,

  // Formalization — captured
  [`${FRM}/define-product-contract/author/singleton`]: formalizationProductContract,
  [`${FRM}/model-use-cases/author/singleton`]: formalizationUseCases,
  [`${FRM}/define-acceptance-contract/author/singleton`]: formalizationAcceptance,
  [`${FRM}/reconcile-what/author/singleton`]: reconciliationAuthor,
  [`${FRM}/define-architecture-contract/author/singleton`]: formalizationArchitecture,
  [`${FRM}/define-product-contract/reviewer/singleton`]: capturedReviewer('define-product-contract'),
  [`${FRM}/model-use-cases/reviewer/singleton`]: capturedReviewer('model-use-cases'),
  [`${FRM}/define-acceptance-contract/reviewer/singleton`]: capturedReviewer('define-acceptance-contract'),
  [`${FRM}/reconcile-what/reviewer/singleton`]: capturedReviewer('reconcile-what'),
  [`${FRM}/define-architecture-contract/reviewer/singleton`]: capturedReviewer(
    'define-architecture-contract', 'factory.review-verdict.v1', 2,
    { srsBundleModuloDerivedHash: true, bundleOrdinal: 2 },
  ),

  // Development — planner captured (3-round repair loop), tail deterministic
  [`${DEV}/plan-task-graph/author/singleton`]: developmentPlan,
  [`${DEV}/implement-work-items/author/*`]: developmentImplement,
  [`${DEV}/implement-work-items/reviewer/*`]: developmentReview,
  [`${DEV}/certify-product-readiness/author/singleton`]: developmentReadiness,
  [`${DEV}/verify-acceptance/author/*`]: developmentVerify,
};
