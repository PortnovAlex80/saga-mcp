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
// 1.7.0 — CERTIFICATION-GAMING-REMEDY M2-2: the provider now attaches an
// ADDITIVE test-coverage report to every outcome (which test files the sealed
// tree's canonical set contains vs which the declaration runs, opaque
// declarations resolved through the sealed package.json). Report only — the
// outcome semantics are byte-for-byte unchanged. The digest bump re-checks
// every prior receipt exactly once (by design).
export const LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION = '1.7.0';
export const LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST = sha256Hex({
  providerId: LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  version: LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
  invariant:
    'exact-frozen-tree-prepared-oci-environment-isolated-test-and-serve-loopback-clean-shutdown-compose-typed-seam-repair-issues',
  commandPolicy:
    'verbatim-profile-commands-on-isolated-host-or-one-prepared-worker-declared-oci-environment-loopback-only',
  composePolicy:
    'declared-compose-config-validated-always-bounded-up-wait-then-down-fail-closed',
  seamIssuePolicy:
    'failures-emit-typed-content-addressed-seam-repair-issues-with-owner-localization-evidence',
  processTerminationPolicy:
    'linux-proc-zombie-aware-and-live-process-tree-fail-closed-v1',
  subjectPolicy: 'accepted-readiness-manifest-bound-to-exact-integrated-source-v1',
  coverageReportPolicy:
    'additive-x-of-y-sealed-tree-canonical-vs-declared-test-files-report-only-never-enforcing-v1',
});
