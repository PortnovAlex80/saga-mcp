// tests/factory-e2e/w9-04-outcome-edge-handlers.mjs
//
// W9-04 per-edge SCRIPTED HANDLERS — one lifecycle outcome edge per scenario
// (CONVEYOR §23, mandatory L3/L4 item 7: every installed outcome edge has a
// real-runtime trace). Each builder extends W9_HAPPY_HANDLERS with exactly ONE
// targeted worker override, leaving every other cell on the happy path — the
// same pattern as w9-03-adversarial-handlers.mjs.
//
// The overrides replace MODEL COGNITION ONLY: the targeted worker submits
// ordinary weak/contradictory/honest material through the normal
// product_submit/artifact_create/artifact_update/worker_done production
// handlers. Gates, check providers, settlement, routing and persistence are
// untouched — the outcome is CLASSIFIED by the factory, never written by the
// scenario (no authority-table writes; see w9-03 for the sanctioned head READ).
//
// Discovery proposals are served from the golden corpus (TASK A): the strength
// code under test is the ONLY field the override changes.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { W9_HAPPY_HANDLERS } from './w9-happy-handlers.mjs';
import { loadCorpus } from '../mock-claude/corpus.mjs';

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  }).trim();
}

const DISC = 'product-discovery@3.0.2';
const FRM = 'solution-formalization@1.0.0';
const DEV = 'solution-development@1.4.3';

function done(handlers, assignment, result) {
  handlers.worker_done({
    task_id: Number(assignment.taskId),
    worker_id: assignment.workerId,
    execution_id: assignment.workerExecutionId,
    result,
  });
}

function findItem(meta) {
  const stack = [meta];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (value.kind === 'verification' && typeof value.key === 'string') return value;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

function findFrozenCandidate(meta) {
  const stack = [meta];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (value.schemaVersion === 'factory.integrated-release-candidate.v1'
      && typeof value.candidateHash === 'string') return value;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery strength codes: go | clarify | reject | defer | inconclusive | failed
//
// Every code routes FORWARD to Formalization (Discovery is a permissive
// idea-strength gate); the emitted code is recorded in the discovery
// certificate. The override changes ONLY recommended_outcome on the corpus
// proposal — an honest worker recommending a weaker idea.
// ---------------------------------------------------------------------------

export function buildDiscoveryStrengthCodeHandlers(code) {
  function discoveryProposalWithCode({ handlers, assignment }) {
    const proposal = loadCorpus().product(
      'produce-proposal', 'factory.discovery-proposal.v1',
    );
    handlers.product_submit({
      schema: 'factory.discovery-proposal.v1',
      content: { ...proposal, recommended_outcome: code },
    });
    done(handlers, assignment,
      `produced discovery proposal with recommended_outcome=${code}`);
    return { kind: 'worker-done-accepted' };
  }
  const handlers = {
    ...W9_HAPPY_HANDLERS,
    [`${DISC}/produce-proposal/author/singleton`]: discoveryProposalWithCode,
  };

  if (code !== 'reject') return handlers;

  // 'reject' is a two-key agreement: the settlement policy emits it only when
  // the WORKER recommends reject AND the readiness ADVISOR coherently agrees
  // (overall not_ready + action reject + ≥1 grounded blocking gap + confidence
  // ≥ REJECT_MIN_CONFIDENCE). The corpus assessment carries the agreeing
  // semantics; only the envelope fields flip, the way the domain defines the
  // verdict — same pattern as the v1→v2 envelope adaptation.
  function agreeingRejectionAssessment({ handlers, assignment, meta, db }) {
    const captured = loadCorpus().product(
      'assess-readiness', 'factory.discovery-readiness-assessment.v1',
    );
    const { proposal_id: _dropped, ...semantic } = captured;
    const assessment = {
      ...semantic,
      overall_readiness: 'not_ready',
      recommended_next_action: 'reject',
      blocking_gaps: [{
        code: 'W9-04-REJECT-1',
        description: 'The advisor agrees with the worker: the proposal should be rejected.',
        source_refs: ['$.risks'],
      }],
      rationale: 'W9-04: worker and advisor agree the proposal should be rejected.',
    };
    // Rebind the proposal hash to THIS run's proposal (the proposal worker
    // submitted the corpus payload with only recommended_outcome changed, so
    // read the digest back from the node input manifest, same as the happy
    // readiness handler does).
    const pni = meta.process_node_input;
    let proposalDigest = null;
    if (pni?.bindings?.items) {
      for (const item of pni.bindings.items) {
        const p = (item.products || []).find(x => x.schemaId === 'factory.discovery-proposal.v1');
        if (p) { proposalDigest = p.digest; break; }
      }
    }
    if (!proposalDigest) {
      const row = db.prepare(
        `SELECT content_hash FROM factory_managed_node_submissions
          WHERE schema_version='factory.discovery-proposal.v1'
          ORDER BY id DESC LIMIT 1`,
      ).get();
      proposalDigest = row?.content_hash;
    }
    if (!proposalDigest) throw new Error('w9-04 disc-reject: proposal digest not found');
    handlers.product_submit({
      schema: 'factory.discovery-readiness-assessment.v2',
      content: { ...assessment, proposal_content_hash: proposalDigest },
    });
    done(handlers, assignment, 'produced agreeing rejection readiness assessment');
    return { kind: 'worker-done-accepted' };
  }
  handlers[`${DISC}/assess-readiness/author/singleton`] = agreeingRejectionAssessment;
  return handlers;
}

// ---------------------------------------------------------------------------
// Formalization → inconsistent
//
// The architecture author creates an EXTRA acceptance criterion while
// authoring the SRS — after the acceptance baseline froze. Per-node gates
// validate their own artifact kind (the SRS), and the cell's accept effect
// duly accepts the extra AC; but settlement re-derives the baseline hash from
// the CURRENT lifecycle-scoped accepted AC rows; the recomputed hash no longer
// matches the frozen baseline and the run terminates inconsistent
// (baseline-missing: hash mismatch).
// ---------------------------------------------------------------------------

export function buildFormalizationInconsistentHandlers() {
  function architectureAuthorAddingExtraAc({ handlers, assignment, context, db, meta }) {
    // An extra AC beyond the frozen baseline (created BEFORE worker_done so
    // the mutation is inside this execution's managed production set).
    const taskRow = db.prepare(
      'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
    ).get(Number(assignment.taskId));
    const projectId = taskRow?.project_id ?? 1;
    const epicId = taskRow?.epic_id ?? 1;
    const body = '# AC-EXTRA: Out-Of-Baseline Criterion\n\nNot part of the frozen baseline.\n';
    const full = path.join(context.workspaceRoot, 'docs/formalization/AC-EXTRA.md');
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf8');
    handlers.artifact_create({
      project_id: projectId, epic_id: epicId,
      type: 'AC', code: 'AC-EXTRA', title: 'AC-EXTRA: Out-Of-Baseline Criterion',
      path: 'docs/formalization/AC-EXTRA.md', status: 'draft',
      content_hash: sha256(body),
    });
    // Produce the happy SRS afterwards (same production as W9_HAPPY_HANDLERS).
    return W9_HAPPY_HANDLERS[`${FRM}/define-architecture-contract/author/singleton`]({
      handlers, assignment, meta, context, db,
    });
  }
  return {
    ...W9_HAPPY_HANDLERS,
    [`${FRM}/define-architecture-contract/author/singleton`]: architectureAuthorAddingExtraAc,
  };
}

// ---------------------------------------------------------------------------
// Formalization → failed
//
// The acceptance-contract author writes an AC document whose atomic headings
// contradict the artifact code: artifact AC-1 carries a document whose only
// AC heading is AC-9. The acceptance gate is STRUCTURAL (traces only) and
// passes; the baseline freeze parses atomic members
// (acceptanceCriteriaForArtifact) and fails terminally — an honest kernel
// failure on contradictory accepted material.
// ---------------------------------------------------------------------------

export function buildFormalizationFailedHandlers() {
  function acceptanceContractWithContradictoryDocument({ handlers, assignment, context, db }) {
    const taskRow = db.prepare(
      'SELECT t.epic_id, e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?',
    ).get(Number(assignment.taskId));
    const projectId = taskRow?.project_id ?? 1;
    const epicId = taskRow?.epic_id ?? 1;
    const repoPath = context.workspaceRoot;

    const acceptedArtifacts = (type) => db.prepare(
      `SELECT id FROM artifacts WHERE epic_id=? AND type=? AND status='accepted' ORDER BY id`,
    ).all(epicId, type);
    const frs = acceptedArtifacts('FR');
    const nfrs = acceptedArtifacts('NFR');
    const ucs = acceptedArtifacts('UC');
    if (!frs.length) throw new Error('w9-04 frm-failed: no accepted FR for acceptance');

    const create = ({ type, code, title, artifactPath, docBody }) => {
      const content = docBody ?? `# ${title}\n\nDeterministic ${type} artifact for ${code}.\n`;
      const full = path.join(repoPath, artifactPath);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
      return handlers.artifact_create({
        project_id: projectId, epic_id: epicId, type, code, title,
        path: artifactPath, status: 'accepted',
        content_hash: sha256(content),
      });
    };
    const trace = (sourceId, targetId, linkType) => handlers.trace_add({
      source_id: sourceId, target_type: 'artifact', target_id: targetId, link_type: linkType,
    });

    // AC-1 whose document headings name a DIFFERENT atomic criterion. The
    // acceptance gate never parses document bodies; the freeze does.
    const ac1 = create({
      type: 'AC', code: 'AC-1', title: 'AC-1: Pipeline Completes',
      artifactPath: 'docs/formalization/AC-1.md',
      docBody: [
        '# AC-1: Pipeline Completes',
        '',
        '## AC-9: Ghost Criterion',
        '',
        'The document contradicts its own artifact identity.',
        '',
      ].join('\n'),
    });
    trace(ac1.id, frs[0].id, 'derived_from');
    if (ucs.length) trace(ac1.id, ucs[0].id, 'derived_from');
    const ac2 = create({
      type: 'AC', code: 'AC-2', title: 'AC-2: NFR Compliance',
      artifactPath: 'docs/formalization/AC-2.md',
    });
    if (nfrs.length) trace(ac2.id, nfrs[0].id, 'derived_from');
    done(handlers, assignment, 'formalization acceptance: contradictory AC document');
    return { kind: 'worker-done-accepted' };
  }
  return {
    ...W9_HAPPY_HANDLERS,
    [`${FRM}/define-acceptance-contract/author/singleton`]: acceptanceContractWithContradictoryDocument,
  };
}

// ---------------------------------------------------------------------------
// Development → rework-required / blocked
//
// An implementation worker reports an HONEST terminal status for the FIRST
// implementation item: everything it declares (commit, scopes, readiness
// contract) is truthful and gate-valid — only terminalStatus is not
// 'complete'. The implementation/review cells accept the report (a worker may
// truthfully fail or be blocked); the settlement workset maps the product's
// terminalStatus verbatim into the item status, and settlement classifies:
// 'failed' → rework-required (implementation-failed),
// 'blocked' → blocked (implementation-blocked).
// ---------------------------------------------------------------------------
// Development → blocked
//
// The frozen integrated candidate DRIFTS: between candidate freeze and
// settlement, an out-of-band change lands on the integration branch (the
// L4-class environmental fault the drift check exists for). Every cell still
// accepts — implementation, integration, readiness and verification all bound
// to the exact frozen candidate — but settlement observes the CURRENT branch
// head, the observed hash no longer equals the frozen candidateHash, and the
// run terminates blocked (candidate-drifted-after-freeze): prior evidence is
// honestly invalidated instead of silently reused.
// ---------------------------------------------------------------------------

export function buildDevelopmentBlockedHandlers() {
  const drifted = new Set();
  function verifyWorkerWithRepositoryDrift({ handlers, assignment, meta, db }) {
    const found = meta.cell_input_item ?? findItem(meta);
    if (!found?.key) throw new Error('verification work item not found');
    const candidate = findFrozenCandidate(meta);
    if (!candidate) throw new Error('frozen candidate not found in verification input');

    // One rogue out-of-band commit on the integration branch, on the FIRST
    // verification invocation only (after freeze, before settlement). This is
    // an ENVIRONMENTAL fault stimulus, not an authority write: the conveyor's
    // own drift observation must catch it.
    if (!drifted.size) {
      drifted.add(found.key);
      const binding = db.prepare(
        `SELECT pr.local_path, pr.integration_branch
           FROM tasks t
           JOIN project_repositories pr ON pr.id = t.project_repository_id
          WHERE t.id = ?`,
      ).get(Number(assignment.taskId));
      const repoPath = binding?.local_path;
      const branch = binding?.integration_branch || 'dev';
      if (repoPath) {
        const marker = path.join(repoPath, 'DRIFT-OUT-OF-BAND.md');
        writeFileSync(marker,
          '# out-of-band change\n\nLanded on the integration branch after candidate freeze.\n', 'utf8');
        git(repoPath, 'checkout', branch);
        git(repoPath, 'add', 'DRIFT-OUT-OF-BAND.md');
        git(repoPath, 'commit', '-m', 'w9-04: out-of-band drift after candidate freeze');
      }
    }

    const acId = Number(found.acceptanceCriterionIds?.[0] || meta.verification_target_artifact_id || 0);
    const acRow = db.prepare(
      'SELECT accepted_hash, content_hash FROM artifacts WHERE id=?',
    ).get(acId);
    const acceptedCriterionHash = acRow?.accepted_hash || acRow?.content_hash;
    if (!acceptedCriterionHash) throw new Error(`accepted hash missing for AC ${acId}`);
    handlers.product_submit({
      schema: 'factory.candidate-verification-evidence-product.v2',
      content: {
        schemaVersion: 'factory.candidate-verification-evidence-product.v2',
        verificationItemKey: found.key,
        acceptanceCriterionId: acId,
        acceptedCriterionHash,
        candidateHash: candidate.candidateHash,
        outcome: 'passed',
        evidence: {
          summary: `W9-04 scripted verification passed for ${found.key}`,
          observations: [`candidate ${candidate.candidateHash.slice(0, 12)}`],
          limitations: [],
        },
      },
    });
    done(handlers, assignment, `verified ${found.key} (repository drifted out-of-band)`);
    return { kind: 'worker-done-accepted' };
  }
  drifted.clear();
  return {
    ...W9_HAPPY_HANDLERS,
    [`${DEV}/verify-acceptance/author/*`]: verifyWorkerWithRepositoryDrift,
  };
}

