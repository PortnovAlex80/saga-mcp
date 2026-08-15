---
id: missing-brief-production
symptom: |
  The generic-flow Discovery worker (saga-discovery-worker) writes a discovery
  document and calls proposal_submit, but no `brief` artifact row is emitted as
  an explicit declared module product. Downstream Formalization requires a
  PRD -> brief `derived_from` trace, and saga-product checks for an accepted
  brief as a precondition. Without it the PRD reviewer loops forever on
  "missing derived_from -> brief".
root_cause_class: missing-production
evidence: |
  - Commit 3110770 "fix(discovery): kernel projects a brief artifact when
    proposal is accepted" (2026-07-28) added ensureDiscoveryBriefArtifact as a
    kernel-side projection in
    src/process-modules/modules/discovery/discovery-installation.ts:163-176,189-212.
  - The current implementation is a "synthetic accepted brief" created as a
    "kernel-side projection" wrapped in try/catch that swallows failures
    (lines 167-173: "Non-fatal: the brief is a convenience projection"). The
    worker never emits the brief as a declared product; it is silently
    projected by the kernel as a unsupported side effect.
  - Plan ref: the brief is NOT a declared module product (plan §14.11.3,
    Phase 10 / Wave 9 fixes this).
reproduction: |
  Static: `grep -n "ensureDiscoveryBriefArtifact" src/process-modules/modules/discovery/discovery-installation.ts`
  shows the brief is produced by a kernel projection, not declared in the
  module manifest's production contract. `grep -n "brief" src/process-modules/modules/discovery/discovery-process-module.ts`
  returns no declared artifact production for the brief type.
  Dynamic (full pipeline): run a Discovery -> Formalization episode through the
  generic flow and inspect `SELECT type FROM artifacts WHERE epic_id=?` — the
  brief row is created by the kernel projection only, not by a worker
  production declared in the module manifest.
expected_after_fix: |
  The brief is a first-class declared module product emitted via the standard
  NodeProductionEnvelope/ProcessModuleOutputEnvelope contract (plan §14.2.1,
  §14.11.3). A worker declares it; the kernel records it; no hidden side-effect
  projection and no try/catch fallback. The brief's existence is provable from
  the module manifest alone.
fixing_waves:
  - "9"
  - "1"
  - "3"
---

# Fixture: missing-brief-production

Captured from the 2026-07-28 failure taxonomy (plan §2.2). This is a
characterization fixture: it freezes the buggy/fragile boundary so later waves
can prove their fix removes the symptom. It is NOT a passing functional test.

## Boundary that is unstable

Discovery's brief is produced by a kernel-side side effect, not by a declared
module product. Adding a new module/scenario cannot rely on this mechanism; the
brief must travel through the standard production contract.

## Why this is a fixture, not a fix

Wave 1 (§14.2) introduces the serializable production contract
(NodeProductionEnvelope / ProcessModuleOutputEnvelope); Wave 3 (§14.4) makes
durable exact products authoritative; Wave 9 / Phase 10 (§14.11.3) migrates
Discovery to declare the brief explicitly. This fixture pins the current
side-effect projection so the Wave 9 exit gate can prove the side effect is
gone.
