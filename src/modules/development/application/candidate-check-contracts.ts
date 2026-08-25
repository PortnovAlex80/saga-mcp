import { sha256Hex } from '../../../shared/canonical-json.js';

export const ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID =
  'factory.accessible-counter-sandbox-check.v1';
export const ACCESSIBLE_COUNTER_CHECK_PROVIDER_VERSION = '1.0.0';
export const ACCESSIBLE_COUNTER_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: ACCESSIBLE_COUNTER_CHECK_PROVIDER_ID,
  version: ACCESSIBLE_COUNTER_CHECK_PROVIDER_VERSION,
  harness: 'isolated-exact-git-tree-counter-dom-storage-keyboard-aria-v1',
});

export const AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID =
  'factory.authorized-verification-observer.v1';
export const AUTHORIZED_OBSERVER_CHECK_PROVIDER_VERSION = '1.0.0';
export const AUTHORIZED_OBSERVER_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: AUTHORIZED_OBSERVER_CHECK_PROVIDER_ID,
  version: AUTHORIZED_OBSERVER_CHECK_PROVIDER_VERSION,
  invariant: 'exact-candidate-method-plan-and-criterion-observer-authorization',
});

export const LOCAL_RUNNABILITY_CHECK_PROVIDER_ID =
  'factory.local-runnability.v1';
// 1.7.0 — M2-2: additive test-coverage report (report only, outcomes
// unchanged).
// 1.8.0 — D1: the sourceCandidate-keyed receipt invariant. Every real result
// now carries a subject binding (local-readiness-subject:<candidateHash>:
// <commitSha>:<treeHash>) and the persisted-receipt replay/conflict lookup is
// keyed by the candidate BYTES the receipt was produced against — a receipt
// can neither travel to a different candidate nor be escaped by sealing a new
// manifest over the same bytes. Outcome semantics per run are unchanged; the
// digest bump re-checks every prior receipt exactly once (by design).
// 1.9.0 — M1-b (step 4): the executed check set is DERIVED from the order.
// A test-command declaration that enumerates files may no longer exclude the
// canonical ones: the gate extends the declaration's own runner and flags
// with the missing sealed-tree files (declarations are additive-only;
// narrowing executes the excluded files anyway and fails honestly).
// Unresolved-opaque declarations keep the M2-2 report-only boundary.
// 1.10.0 — K19 (ADR-083 §2.1/2.2, train commits 2-3 core): the DERIVED
// EXECUTION ENVIRONMENT. The environment identity is derived from the exact
// sealed artefact (import scan vs manifests vs declared install); the
// declaration is additive, never definitive. An undeclared import is caught
// BY DERIVATION before any spawn: the install command is augmented with the
// missing packages (same runner), or the check fails closed with a typed
// ENVIRONMENT_DERIVATION_UNDECLARED_NEED when there is no install to
// augment. environmentDigest rides every outcome — preparation and
// certification hold one immutable identity.
// 1.11.0 — CC-GAP-9 / ADR-089: bounded deterministic in-check substrate
// retry for exactly the two environment-precondition codes
// (LOCAL_RUNNABILITY_DOCKER_UNAVAILABLE, LOCAL_RUNNABILITY_DOCKER_NOT_LINUX)
// with a FROZEN attempt bound and schedule (substrate-retry.ts; never env,
// model, repair budget or CandidateSet); on exhaustion the check emits the
// typed unknown `warrant-blocked-environment` outcome with attempt evidence
// and NO seam repair issue. Outcome semantics change honestly: a missing
// environment precondition is no longer a 'failed' product verdict — the
// digest bump re-checks every prior receipt exactly once (by design).
// 1.12.0 — CC-GAP-9 residual / ADR-091: readiness-substrate TOCTOU re-probe.
// On a mid-check executor/compose step failure the cached availability probe
// is invalidated and the daemon mechanically re-probed; ONLY the observed
// result routes (observed unavailable/not-linux re-enters the ADR-089 bounded
// retry/typed unknown path; observed available+linux keeps the ORIGINAL
// product `failed`); classification never reads the failed command's stderr;
// compose `down` stays best-effort and distinct from invalid config (ENOENT
// CLI-missing keeps LOCAL_RUNNABILITY_COMPOSE_UNAVAILABLE). No new outcome
// class, no retry-policy change — the digest bump re-checks every prior
// receipt exactly once (by design).
// 1.13.0 — K19 (ADR-083 §2.1, image/dependency identity remainder): the
// environment identity is AUTHORITATIVE. A docker-substrate check resolves
// the declared image to its OCI REGISTRY MANIFEST DIGEST (RepoDigests —
// never a floating tag, never the local image id) and fails closed typed
// ENVIRONMENT_IMAGE_IDENTITY_{MISSING,MALFORMED,REPO_MISMATCH,AMBIGUOUS,
// PIN_MISMATCH} on bad evidence BEFORE any build; the derivation binds the
// dependency lock identity (dependencyLockDigest over the sealed tree's
// exact lock material — lock drift is a different environmentDigest); both
// identities ride every observation and bind the deterministic receipt
// digest. Identity failures are product `failed` (K19 owns identity), never
// the ADR-089 substrate unknown (ADR-091/089 own availability; ADR-083 §6
// split) and consume no substrate retry — the digest bump re-checks every
// prior receipt exactly once (by design).
// 1.14.0 — K19 repair after REJECT: three proven blockers closed. (1) The
// base image identity is observed ATOMICALLY: ONE docker image inspect
// snapshot resolves ONE image object, RepoDigests and the local Id are
// PAIRED facts of that same response, and only the immutable Id is tagged —
// the pre-fix two-inspect read on the MUTABLE declared tag let a concurrent
// tag switch pair A's manifest digest (the receipt identity) with B's local
// id (the executed image). (2) The PROVIDER BOUNDARY fails closed typed
// when a docker describe reaches the receipt without a well-formed sha256
// baseImageDigest — a product failure, never passed, never the substrate
// unknown, never retried. (3) The trusted_providers migration requires the
// EXACT version→built-in-digest pair (a forged trust_basis on a known
// legacy version is LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT, never laundered)
// — the digest bump re-checks every prior receipt exactly once (by design).
// 1.15.0 — CC-GAP-7 warrant execution: a manifest-carried
// VerificationWarrantRef executes through package-declared oracle adapters.
// The warrant authority is cross-bound DB-only (discovery certificate by
// exact hash → verified frozen register → the DevelopmentCase's
// authoritative expected cross-bind identities → the inherited
// constraintRegisterCoverage relay); identity violations are typed product
// failures. Every non-waived EXECUTION-class register entry must be
// covered by a DECLARED adapter whose deterministic evidence command runs
// in the SAME prepared environment inside the ADR-089/091 substrate
// attempt (mid-check daemon deaths keep the observed re-probe
// classification). The generic served phases (start + loopback HTTP probe
// + stop) are transport-only evidence and NEVER adapter coverage: a
// missing adapter, an unsupported claim, or transport-only evidence yields
// the typed `warrant-oracle-insufficient` unknown — never a pass, never a
// product-failed verdict. An ABSENT warrant keeps the explicit no-warrant
// legacy path byte-identical (the sole grandfathered shape). The passed
// receipt binds the warrant identity, the executed adapter
// identities/versions, and the CONSUMED derived environmentDigest
// (ADR-083 §6: consume and receipt-bind, never authorize — the adapter
// never authorizes environment identity) — the digest bump re-checks every
// prior receipt exactly once (by design).
// 1.16 (HUMAN-GATE-CONSOLE): the operator's answer to a human_required park
// is a wake source for this provider's typed `unknown`. A persisted
// accept/reject resolution for the SAME workplace and the SAME candidate
// bytes (subject binding guard) converts the unknown into passed/failed as
// check evidence citing the resolution — never a forged receipt, never a
// conversion for different bytes. All other outcomes unchanged.
export const LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION = '1.16.0';
export const LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  version: LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
  invariant:
    'exact-frozen-tree-prepared-oci-environment-isolated-test-and-serve-loopback-clean-shutdown-compose-typed-seam-repair-issues',
  commandPolicy:
    'canonical-test-set-derived-from-sealed-tree-declarations-additive-only-verbatim-runner-and-flags-on-isolated-host-or-one-prepared-worker-declared-oci-environment-loopback-only',
  composePolicy:
    'declared-compose-config-validated-always-bounded-up-wait-then-down-fail-closed',
  seamIssuePolicy:
    'failures-emit-typed-content-addressed-seam-repair-issues-with-owner-localization-evidence',
  humanGateResolutionPolicy:
    'a-typed-unknown-consults-the-append-only-factory_human_gate_resolutions-for-the-same-workplace-and-provider-and-converts-only-when-the-resolution-subject-binding-equals-the-current-candidate-bytes-binding-accept-converts-to-passed-reject-to-failed-with-the-operator-feedback-in-the-diagnostic-evidence-cites-human-gate-resolution-id-and-actor-the-original-unknown-diagnostic-is-retained-no-resolution-no-table-or-binding-mismatch-keeps-the-unknown-unchanged-fail-closed-v1',
  processTerminationPolicy:
    'linux-proc-zombie-aware-and-live-process-tree-fail-closed-v1',
  subjectPolicy: 'accepted-readiness-manifest-bound-to-exact-integrated-source-v1',
  coverageReportPolicy:
    'additive-x-of-y-sealed-tree-canonical-vs-declared-test-files-report-only-never-enforcing-v1',
  subjectBindingPolicy:
    'receipts-bound-to-exact-candidate-bytes-candidatehash-commitsha-treehash-replay-across-manifests-conflict-on-failed-plus-passed-same-bytes-v1',
  substrateRetryPolicy:
    'bounded-deterministic-in-check-substrate-retry-frozen-attempt-bound-and-schedule-for-docker-unavailable-and-docker-not-linux-only-then-typed-unknown-warrant-blocked-environment-with-attempt-evidence-no-seam-repair-issue-unknown-receipts-never-replayed-never-poison-a-later-pass-v1',
  midCheckReprobePolicy:
    'on-mid-check-executor-or-compose-step-failure-invalidate-the-cached-availability-probe-and-mechanically-re-probe-only-observed-unavailable-or-not-linux-routes-into-the-adr-089-bounded-retry-and-typed-unknown-observed-available-plus-linux-keeps-the-original-product-failure-never-classify-from-stderr-text-compose-down-stays-best-effort-distinct-from-invalid-config-enoent-cli-missing-keeps-compose-unavailable-v1',
  imageIdentityPolicy:
    'declared-docker-image-resolves-to-its-oci-registry-manifest-digest-from-repodigests-never-a-floating-tag-never-the-local-image-id-fail-closed-typed-before-any-build-on-missing-malformed-repo-mismatched-ambiguous-or-pin-mismatched-evidence-identity-failures-are-product-failed-never-the-substrate-unknown-and-consume-no-substrate-retry-k19-owns-identity-adr-091-owns-availability-v1',
  imageSnapshotPolicy:
    'base-image-identity-is-observed-atomically-one-docker-image-inspect-snapshot-resolves-one-image-object-repodigests-and-the-local-id-are-paired-facts-of-the-same-response-and-only-the-immutable-id-of-that-snapshot-is-tagged-never-two-inspects-on-the-mutable-declared-tag-and-the-provider-boundary-fails-closed-typed-when-a-docker-describe-reaches-the-receipt-without-a-well-formed-sha256-baseimageDigest-product-failed-never-passed-never-unknown-never-retried-v1',
  providerTrustPolicy:
    'trusted-providers-migration-requires-the-exact-version-to-builtin-digest-pair-of-the-shipped-lineage-plus-exact-metadata-a-forged-trust-basis-on-a-known-legacy-version-is-local-runnability-trust-policy-drift-never-laundered-into-the-current-trust-v1',
  dependencyLockPolicy:
    'dependency-lock-identity-is-the-sha256-over-the-sealed-trees-exact-resolved-lock-material-and-binds-the-derived-environment-digest-and-every-receipt-lock-drift-is-a-different-environment-an-empty-lock-list-is-reported-honestly-never-fabricated-v1',
  warrantOraclePolicy:
    'a-present-verificationwarrantref-executes-only-through-package-declared-oracle-adapters-with-the-authority-cross-bound-db-only-discovery-certificate-by-exact-hash-verified-frozen-register-developmentcase-expected-cross-bind-identities-and-inherited-coverage-relay-identity-violations-are-typed-product-failures-every-non-waived-execution-class-register-entry-must-be-covered-by-a-declared-adapter-whose-deterministic-evidence-command-runs-in-the-same-prepared-environment-inside-the-adr-089-091-substrate-attempt-the-generic-served-phases-start-loopback-http-probe-stop-are-transport-only-evidence-and-never-adapter-coverage-a-missing-adapter-unsupported-claim-or-transport-only-evidence-yields-the-typed-warrant-oracle-insufficient-unknown-never-a-pass-never-a-product-failed-verdict-an-absent-warrant-keeps-the-explicit-no-warrant-legacy-path-the-passed-receipt-binds-warrant-and-executed-adapter-identities-versions-and-the-consumed-derived-environmentdigest-the-adapter-never-authorizes-environment-identity-adr-083-section-6-v1',
});
