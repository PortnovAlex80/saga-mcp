// tests/factory-contract/snapshot-stage11-scenarios.mjs
//
// SNAPSHOT-TEST tape: replay of the REAL stage-11 docking run
// (factory-snapshots/stage11-replay-fitness, captured 2026-08-19) against the
// CURRENT factory through the real orchestrate-cli / MCP-gateway seam.
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
//   product-discovery@3.0.2        produce-proposal, assess-readiness
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

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actions } from './scenario-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(__dirname, '../fixtures/golden-corpus/stage11-docking');

const FRM = 'solution-formalization@1.0.0';
const DISC = 'product-discovery@3.0.2';
const DEV = 'solution-development@1.4.4';

// --- corpus access (fail-closed; the corpus is the ONLY text source) ---

function corpusFile(relative) {
  return JSON.parse(readFileSync(path.join(CORPUS_ROOT, relative), 'utf8'));
}

function corpusText(relative) {
  // CRLF-safe load: a Windows checkout may materialize the committed LF bytes
  // as CRLF (core.autocrlf). The captured documents are LF; normalize back so
  // content hashes stay byte-stable regardless of checkout platform.
  return readFileSync(path.join(CORPUS_ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

function productFile(node, schema, ordinal) {
  return corpusFile(`products/${node}.${schema}.${ordinal}.json`);
}

const MANIFEST = corpusFile('manifest.json');

function documentFor(sourcePath) {
  const entry = MANIFEST.documents.find(doc => doc.source === sourcePath);
  if (!entry) throw new Error(`SNAPSHOT_CORPUS_DOCUMENT_MISSING: ${sourcePath}`);
  return corpusText(entry.file);
}

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

async function replayArtifactCell({ client, task, prompt, repoPath }, node, firstArtifact, lastArtifact, firstTrace, lastTrace) {
  const projectId = task.project_id || 1;
  const epicId = task.epic_id || 1;
  const finalHashes = finalContentHashes(node);
  const specs = [];
  for (let id = firstArtifact; id <= lastArtifact; id += 1) {
    specs.push(artifactSpec(node, id, finalHashes));
  }

  // Write the captured document bytes (idempotent for anchor-shared files),
  // then create artifacts in captured id order. Each document's bytes must
  // hash to the captured artifact contentHash — fail-closed corpus check.
  const written = new Set();
  for (const spec of specs) {
    const filePath = spec.path.split('#')[0];
    if (repoPath && !written.has(filePath)) {
      const source = `artifacts/requirements/${filePath.replace(/^docs\/requirements\//, '')}`;
      const body = documentFor(source);
      const digest = createHash('sha256').update(body, 'utf8').digest('hex');
      const expected = MANIFEST.documents.find(doc => doc.source === source)?.contentHash;
      if (expected && digest !== expected) {
        throw new Error(`SNAPSHOT_CORPUS_DRIFT: document ${source} hashes ${digest}, corpus says ${expected}`);
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
      ...(spec.type === 'brief' ? { metadata: { brief_payload: derivedBriefPayload(task) } } : {}),
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
const formalizationAcceptance = ctx => replayArtifactCell(
  ctx, 'define-acceptance-contract', 12, 16, 15, 28,
);
// Architecture replays only the ACCEPTED (v2) round — see file header.
const formalizationArchitecture = ctx => replayArtifactCell(
  ctx, 'define-architecture-contract', 17, 17, 29, 29,
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
// Reviewers (captured verdicts, byte-exact via ref-consistency oracle)
// ---------------------------------------------------------------------------

function capturedReviewer(verdictNode, schema = 'factory.review-verdict.v1', ordinal = 1) {
  return async ({ client, task, prompt }) => {
    const verdict = productFile(verdictNode, schema, ordinal);
    const workplaceRef = metaOf(task).workplace_ref;
    if (!workplaceRef) throw new Error('SNAPSHOT_WORKPLACE_REF_MISSING');
    const candidate = await actions.readAuthorCandidate(client, workplaceRef);
    // The captured verdict's subject ref embeds the content hash of the
    // author candidate. If the author replay is byte-exact, the runtime ref
    // IS the captured ref — anything else is replay drift.
    if (candidate.candidate_set_ref !== verdict.subject_candidate_set_ref) {
      throw new Error(
        `SNAPSHOT_REPLAY_DRIFT: runtime candidate ref ${candidate.candidate_set_ref} `
        + `!= captured ${verdict.subject_candidate_set_ref}`,
      );
    }
    await actions.submitProduct(client, schema, verdict);
    await actions.done(client, Number(prompt.task_id), prompt.worker_id, prompt.execution_id,
      `snapshot replay: captured review verdict (${verdict.verdict})`);
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

const developmentPlan = async ({ client, task, prompt, attempt }) => {
  // Captured loop: proposal #1 gate-rejected, #2 gate-rejected, #3 accepted.
  // Attempt->ordinal mapping cycles so a durable lease-recovery attempt can
  // never strand the cell; the gate still only accepts proposal #3's bytes.
  const ordinal = ((attempt - 1) % PLANNER_PROPOSALS.length) + 1;
  await actions.submitProduct(
    client, 'factory.development-task-graph-proposal.v1', PLANNER_PROPOSALS[ordinal - 1],
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
  const acId = Number(item.acceptanceCriterionIds?.[0] || task.verification_target_artifact_id || 0);
  if (!acId) throw new Error('verification acceptanceCriterionId missing');
  const acResp = await client.callJson('artifact_get', { id: acId });
  const ac = acResp.artifact || acResp;
  const acceptedCriterionHash = ac.accepted_hash || ac.content_hash;
  if (!acceptedCriterionHash) throw new Error(`accepted hash missing for AC ${acId}`);
  const evidenceBody = {
    verificationItemKey: item.key,
    acceptanceCriterionId: acId,
    candidateHash: candidate.candidateHash,
    result: 'passed',
  };
  const evidenceHash = createHash('sha256').update(JSON.stringify(evidenceBody)).digest('hex');
  await actions.submitProduct(client, 'factory.candidate-verification-evidence-product.v2', {
    schemaVersion: 'factory.candidate-verification-evidence-product.v2',
    verificationItemKey: item.key,
    acceptanceCriterionId: acId,
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
  ),

  // Development — planner captured (3-round repair loop), tail deterministic
  [`${DEV}/plan-task-graph/author/singleton`]: developmentPlan,
  [`${DEV}/implement-work-items/author/*`]: developmentImplement,
  [`${DEV}/implement-work-items/reviewer/*`]: developmentReview,
  [`${DEV}/certify-product-readiness/author/singleton`]: developmentReadiness,
  [`${DEV}/verify-acceptance/author/*`]: developmentVerify,
};
