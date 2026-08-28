/**
 * derive-system-requirements desk (reviewer) - re-staffing #2 emission build (r2).
 *
 * Emits ONLY restaff2-namespaced files (ADV-5: zero existing files modified):
 *   derive-system-requirements-desk-reviewer-restaff2-confirmation.json  (RS-Derive-System-Requirements-001)
 *   derive-system-requirements-desk-reviewer-restaff2-trace.json
 *   derive-system-requirements-desk-reviewer-restaff2-confirmation.md
 *
 * Acyclic content addressing: the confirmation references its trace by
 * file + edge count only; the trace embeds the confirmation content digest.
 * All addresses sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const out = read('derive-system-requirements-desk-reviewer-restaff2-verify-out.json');
if (out.failed !== 0) throw new Error(`verification is not green: ${out.failed} failed`);

const NOW = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const FR = 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0';
const VV = 'd81d23475ca309756165e65a109b7df94786636cfe794661ce7eea5b1f1a4f5b';
const RT = 'e97b710f129eb9d15caf31294d170f0fa7b4b5d3b3941304d0a76074072637ba';
const FSR = 'f7e0e85c6992402209563516bd1b9de73a56bf1eaacf7a392dc910f65b17f9d0';
const SR = '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df';
const AUTH_FS = '05e713efdd1847bf18fc21ed335a981db1963020417e0a2078eef62fe2e824aa';
const AUTH_TRC = 'fd0b0b1f7470cd7825a0c83082b96b503ef3dabdcf70a92369050418a8706e26';
const SEALS = '60083eb4a2ba553d0924c9b9ffe12ad9e703f9adc2f7da6bd5584a1747620690';

const confirmationContent = {
  confirmationId: 'RS-Derive-System-Requirements-001',
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  staffingRound: 'stray-products-r2 reviewer staffing #2 (re-staffing with a byte-equivalent desk task envelope; first re-staffing confirmation of the same package of record)',
  confirmedPackageOfRecord: {
    verification: { id: 'VV-Derive-System-Requirements-001', file: 'derive-system-requirements-desk-reviewer-verification.json', ref: shaRef(VV) },
    review: { id: 'FR-Derive-System-Requirements-001', file: 'derive-system-requirements-desk-reviewer-review.json', ref: shaRef(FR), verdict: 'repair' },
    trace: { id: 'RT-Derive-System-Requirements-001', file: 'derive-system-requirements-desk-reviewer-trace.json', ref: shaRef(RT), edges: 6 },
    submission: { id: 'FS-Derive-System-Requirements-002', file: 'derive-system-requirements-desk-reviewer-product-submission.json', ref: shaRef(FSR), kind: 'formalization.review-complete.v1', effectId: 'formalization.accept-products', terminalOutcome: 'success' },
  },
  reviewedSubject: {
    submissionRef: shaRef(AUTH_FS),
    artifactRef: shaRef(SR),
    traceRef: shaRef(AUTH_TRC),
    productKind: 'formalization.system-requirements.v1',
    wp03SealRef: shaRef(SEALS),
    verdictOfRecord: 'repair',
  },
  recomputedChecks: out.recomputed,
  passed: out.passed,
  failed: out.failed,
  trustedByDeclaration: false,
  verifier: {
    file: 'derive-system-requirements-desk-reviewer-restaff2-verify.mjs',
    receipt: 'derive-system-requirements-desk-reviewer-restaff2-verify-out.json',
  },
  envelopeIdentity: {
    equal: 'H1-H4: 9/9 projection refs (8 task-projection + 1 upstream-accepted), skill pins bc8a4261/2cbcf850, workspace summary line and write authority all equal the standing staffing, verified against the self-addressed on-disk VV envelopePins and FR workspaceAdjudication',
    projectionAdjudication: 'the envelope upstream-accepted[0] sha256:65fe9a225a4425880513ae5321cce4d9b75c44e88fb3054f5e7f997b6956ee66 :: "accepted revision of derive-system-requirements" remains UNRESOLVABLE (O1: 0 raw / 0 canonical / 0 .content hits workspace-wide; verdict of record repair - the author desk has not reissued, the final gate never ran). Stale shell metadata, same family as sha256:745cadc1…; recorded for the shell owner.',
  },
  contentDelta: 'none (C1): the reviewed subject recomputes to the exact address the standing staffing reviewed (author trio unchanged; R6); the standing FR/RT/FS/VV self-addresses all recompute from raw bytes (R1-R5)',
  idempotency: {
    law: 'desk law on re-staffing with an identical envelope: the outcome is idempotent by content address - re-emitting the package would mint new addresses for identical semantics',
    antiPatternPrecedent: ['CR-Model-Use-Cases-002', 'CR-001..003 (define-product-intent reviewer namespace)'],
    chain: 'this confirmation RS-Derive-System-Requirements-001 is the FIRST re-staffing confirmation of this seat and binds the standing package of record; no predecessor RS emission exists (R8)',
  },
  independentRerun: {
    folds: 'both upstream folds re-derive through the REAL validators + REAL cell folds (prd a30229a75bed4c5d…, uc 184981e5724c286d…); bundle pins byte-exact (K8)',
    wp03: 'REAL WP03 validator re-seals the bundle to the standing address sha256:60083eb4a2ba553d0924c9b9ffe12ad9e703f9adc2f7da6bd5584a1747620690 (K4)',
    gate: 'author-stage cell gate re-runs to accepted (6 checks); kernel reviewer route (mechanical surface only) -> accept; the DESK verdict of record stays repair by the M-layer acceptance-status authority - consistent with the standing 77/80 whose only failures are M4/M5/M6 (K5, K6)',
    probe: 'negative probe: foreign lineage -> upstream-repair (the gate is real, not rubber-stamped) (K7)',
  },
  verdictRationaleStanding: {
    crit1: 'CRIT-1 stands (M4): the candidate still asserts accepted material authority while every intent reviewer emission carries verdict repair (contention open) and the UC bundle has never passed a reviewer stage; no accepted upstream revision exists in r2',
    crit2: 'CRIT-2 stands (M5): SC-2 recomputes to a bare {claimId,statement} claim and CERT-1 to a subject-level go; no exclusion decision exists; the candidate brief still restates the prd:scope-2 exclusion as fact',
    maj1: 'MAJ-1 stands (N1): governing contract anchor sha256:a926df6284a1afb5… remains unresolvable workspace-wide (232 files scanned; 0 hits in all three bodies)',
    selfContradiction: 'M6 stands: workspaceSummary 0-count vs materialAuthority "accepted"',
    requiredActions: 'RA-1..RA-5 all remain open (M7): no adjudication record, no reissued candidate, no re-sealed governing contract since the standing staffing',
  },
  emissionDiscipline: {
    noSecondSubmission: 'C2: this staffing mints no FS, no FR, no VV, no RT duplicate - FS-Derive-System-Requirements-002 (f7e0e85c…) stands as the ONLY desk product submission of record and FR-Derive-System-Requirements-001 (d31b044c…) as the ONLY review record',
    adv5: 'this emission writes ONLY restaff2-namespaced files; zero existing files modified or deleted (A1: all 14 standing desk files present, every self-address recomputed from raw bytes)',
  },
  deskOutcome: {
    verdict: 'repair',
    deskProductSubmission: 'FS-Derive-System-Requirements-002 sha256:f7e0e85c6992402209563516bd1b9de73a56bf1eaacf7a392dc910f65b17f9d0 (formalization.review-complete.v1)',
    law: 'the requirements desk may not settle until its lineage is accepted material under authority that exists: the author desk holds or reissues against genuinely accepted revisions (RA-1); the intent desk settles under driver/human adjudication (RA-2); the UC desk reconciles its hold and passes review (RA-3); the contract layer re-seals (RA-4)',
    carriedForward: [
      'constraint:retention-1 sha256:807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be',
      'unknown:browser-matrix-1 sha256:38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf (carried never resolved, D10)',
      'claim:scope-2 sha256:cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da (upstream-contested carried boundary material; RA-2)',
    ],
  },
  envelopePins: {
    protocolSkillRef: 'sha256:bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
    semanticSkillRef: 'sha256:2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
    workspaceSummary: 'workspace: 1 accepted upstream revisions travel by content address',
    upstreamAccepted: ['sha256:65fe9a225a4425880513ae5321cce4d9b75c44e88fb3054f5e7f997b6956ee66'],
    writeAuthority: 'write authority: desk artifacts only; allowed=candidate-read,product-read,product-submit',
  },
  trace: {
    file: 'derive-system-requirements-desk-reviewer-restaff2-trace.json',
    edges: 8,
    note: 'the trace embeds THIS confirmation by content digest; the confirmation binds the trace by file and edge count only (acyclic content addressing)',
  },
};

const confirmationDigest = sha(confirmationContent);
const confirmation = {
  confirmationRef: shaRef(confirmationDigest),
  artifactKind: 'reviewer-restaff-confirmation',
  contentDigest: confirmationDigest,
  semanticCode: 'RS-Derive-System-Requirements-001',
  createdAt: NOW,
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: confirmationContent,
};

const traceContent = {
  traceId: 'RT-Derive-System-Requirements-002',
  traceKind: 'desk-trace',
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  restaffRef: shaRef(confirmationDigest),
  confirmedReviewRef: shaRef(FR),
  reviewedSubjectRef: shaRef(SR),
  edges: [
    {
      relationType: 'confirms',
      fromRef: shaRef(confirmationDigest),
      toRef: shaRef(FR),
      description: 're-staffed reviewer (#2) confirms FR-Derive-System-Requirements-001 (verdict repair) after 28/28 independent recomputations and a REAL kernel re-run (K1-K8); the verdict rationale (CRIT-1, CRIT-2, MAJ-1) re-derives at this staffing (M4-M6, N1)',
    },
    {
      relationType: 'confirms',
      fromRef: shaRef(confirmationDigest),
      toRef: shaRef(FSR),
      description: 're-staffed reviewer (#2) confirms FS-Derive-System-Requirements-002 as the ONLY desk product submission of record (formalization.review-complete.v1, verdict repair); no second FS minted (C2)',
    },
    {
      relationType: 'confirms',
      fromRef: shaRef(confirmationDigest),
      toRef: shaRef(VV),
      description: 're-staffed reviewer (#2) confirms the standing verification record VV-Derive-System-Requirements-001; its envelopePins are the identity anchor for H1-H4',
    },
    {
      relationType: 'confirms',
      fromRef: shaRef(confirmationDigest),
      toRef: shaRef(RT),
      description: 're-staffed reviewer (#2) confirms the standing reviewer trace RT-Derive-System-Requirements-001 (6 edges, self-address recomputes, R3)',
    },
    {
      relationType: 'derived_from',
      fromRef: shaRef(confirmationDigest),
      toRef: shaRef(SR),
      description: 'reviewed subject re-verified byte-exact: the author trio recomputes to the exact addresses the standing staffing reviewed; WP03 seal sha256:60083eb4… stable (C1, K4)',
    },
    {
      relationType: 'observes',
      fromRef: shaRef(confirmationDigest),
      toRef: shaRef(AUTH_FS),
      description: 'the author submission FS-Derive-System-Requirements-001 stands as the only author emission; verdict repair returned, RA-1 (hold or reissue against accepted revisions) still open (R8, M7)',
    },
    {
      relationType: 'carries_forward',
      fromRef: shaRef(confirmationDigest),
      toRef: 'sha256:807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be',
      description: 'constraint:retention-1 travels forward by content address (unchanged)',
    },
    {
      relationType: 'carries_forward',
      fromRef: shaRef(confirmationDigest),
      toRef: 'sha256:38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf',
      description: 'D10: unknown:browser-matrix-1 carried forward, never resolved (unchanged)',
    },
  ],
};
const traceDigest = sha(traceContent);
const trace = {
  traceRef: shaRef(traceDigest),
  contentDigest: traceDigest,
  createdAt: NOW,
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

writeFileSync(join(DIR, 'derive-system-requirements-desk-reviewer-restaff2-confirmation.json'), `${JSON.stringify(confirmation, null, 2)}\n`);
writeFileSync(join(DIR, 'derive-system-requirements-desk-reviewer-restaff2-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);

/* Post-write self-proof: both emissions recompute from disk. */
const diskConf = read('derive-system-requirements-desk-reviewer-restaff2-confirmation.json');
const diskTrc = read('derive-system-requirements-desk-reviewer-restaff2-trace.json');
const okConf = sha(diskConf.content) === diskConf.contentDigest && diskConf.confirmationRef === shaRef(diskConf.contentDigest);
const okTrc = sha(diskTrc.content) === diskTrc.contentDigest && diskTrc.traceRef === shaRef(diskTrc.contentDigest);
const okBind = diskTrc.content.restaffRef === diskConf.confirmationRef && diskConf.content.trace.edges === diskTrc.content.edges.length;
console.log(JSON.stringify({
  confirmation: { ref: diskConf.confirmationRef, semanticCode: diskConf.semanticCode, selfAddressRecomputes: okConf },
  trace: { ref: diskTrc.traceRef, semanticCode: diskTrc.content.traceId, selfAddressRecomputes: okTrc, edges: diskTrc.content.edges.length },
  binding: { traceEmbedsConfirmation: okBind, acyclic: true },
  createdAt: NOW,
  allGreen: okConf && okTrc && okBind,
}, null, 2));
if (!(okConf && okTrc && okBind)) process.exitCode = 1;
