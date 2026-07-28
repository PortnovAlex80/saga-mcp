---
id: no-op-port
symptom: |
  A declared module port that the production composition root wires to a stub
  no-op (throws "NOT_REACHED" or returns nothing) instead of a real adapter.
  The pipeline runs through stages whose ports are structurally unimplemented,
  so end-to-end success depends on the composition silently skipping those
  ports rather than calling them.
root_cause_class: no-op-port
evidence: |
  - product-lifecycle-composition.mjs:30-35 defines `notReached = (label) => () => { throw new Error('PRODUCT_LIFECYCLE_TEST_<label>_NOT_REACHED: the <label> port was invoked. Supply a real provider to continue.') }`.
  - product-lifecycle-composition.mjs:48-57 wires four Delivery ports to
    notReached stubs: preflightState, approval, publication, observation,
    settlementState. The file header (line 12-13) states: "Delivery providers
    remain no-ops (throw if reached) until we wire real publication/observation
    adapters."
  - Commit fd52982 "fix(development): stamp full provenance on projected tasks
    + real dev ports" (2026-07-28) explicitly removed no-op DEVELOPMENT ports
    (taskGraph, implementationWorkset, candidateIntegration,
    acceptanceVerification, settlementState) so the composition root falls
    back to SqliteDevelopmentRuntime — confirming the ports were previously
    stubbed in production composition.
  - The composition root src/process-modules/composition/product-lifecycle-runtime.ts:222-262
    assembles deliveryDeps via requireDeliveryPort(...) which throws unless a
    provider is supplied — i.e. delivery ports are mandatory in shape but
    unimplemented by default.
reproduction: |
  Static: `grep -n "notReached\|NOT_REACHED\|no-op\|noop" product-lifecycle-composition.mjs`
  Command: `git show fd52982 -- product-lifecycle-composition.mjs` (the file
  itself documents delivery ports as no-ops).
  Dynamic: invoke the product lifecycle with the default composition and reach
  a Delivery publication/observation node — the executor throws
  PRODUCT_LIFECYCLE_TEST_publication_NOT_REACHED.
expected_after_fix: |
  Every declared port in a module manifest has a real, composed adapter; there
  is no "throw if reached" path in production composition. Installation
  validation (plan §14.3 / Wave 2) refuses to install a module/scenario whose
  declared ports lack a bound adapter, so an unimplemented port fails fast at
  install time, not at runtime inside a stage.
fixing_waves:
  - "9"
  - "11"
  - "2"
---

# Fixture: no-op-port

Captured from the 2026-07-28 failure taxonomy (plan §2.2). Plan refs §0.3.7,
§2.2; task file W00-A6 item 5 names composition/product-lifecycle-runtime.ts
as the locus and Wave 9/11 as the fixing waves.

## Boundary that is unstable

The composition root can wire a declared port to a stub that throws. There is
no install-time gate requiring that every declared port has a real adapter, so
a "complete" lifecycle scenario can ship with structurally unimplemented ports.

## Why this is a fixture, not a fix

Wave 2 (immutable installation, plan §14.3) and the module migration waves
(§14.11 Discovery / Wave 9, and the later delivery/publication wiring / Wave
11) make port-adapter binding a declared, validated part of installation. This
fixture pins the current throw-stub so those waves can prove the stub is gone
and the port is bound for real.
