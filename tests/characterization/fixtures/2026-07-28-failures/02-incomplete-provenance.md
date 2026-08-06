---
id: incomplete-provenance
symptom: |
  Managed products must never be accepted with incomplete execution lineage.
root_cause_class: incomplete-provenance
evidence: |
  Production Cell role projection reads the immutable ProcessRun input hash,
  canonically hashes the exact desk input, binds the WorkIntent, and the managed
  production ledger rejects any incomplete binding.
reproduction: |
  Run the Production Cell tests and the full mock factory. Both assert exact
  input hashes and managed-submission provenance.
expected_after_fix: |
  Every accepted product is bound to its ProcessRun, node, WorkIntent, task,
  execution fence, immutable order hash, and canonical desk-input hash.
fixing_waves:
  - "3"
  - "1"
---

# Fixture: complete provenance

## Required invariant

Provenance is complete before a role task becomes claimable. The managed
production ledger fails closed when any binding is absent or inconsistent.

## Acceptance proof

This fixture pins the target invariant so future changes cannot introduce
best-effort or nullable provenance.
