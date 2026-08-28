# define-acceptance-contract desk (author) — UPSTREAM HOLD submission summary

**Emission:** UH-Define-Acceptance-Contract-001
**artifact:** `sha256:a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84` (`define-acceptance-contract-desk-upstream-hold.artifact.json`)
**trace:** `sha256:b5e7969fe2d4b6b2391716e0cfe167d7dc5501e79fa2a7a452a3ad87e4d5053f` (`define-acceptance-contract-desk-upstream-hold-trace.json`)
**decision:** `hold-no-authoring` — no acceptance-contract material authored.

## Why this desk holds instead of authoring

The desk's candidate of record (SR-Define-Acceptance-Contract-001, `sha256:2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0`, byte-unchanged) asserted accepted upstream lineage. Reviewer emission A (FR-Define-Acceptance-Contract-001 `sha256:83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383`, VV `sha256:367a38fcf8d0bd061fa2e023aba4aaab0060a82a71278ca358d6b3415b5602bb`, 99 recomputations / 7 hard failures) and this seat's own independent recomputation prove the three consumed links are NOT accepted:

1. **define-product-intent** `sha256:a06dbc57…` — verdict **repair** across every emission (FR-001 `e49d8d11…`, FR-001-b `6c9c8324…`, FR-002 `04632094…`); no author reissue anywhere in r1/r2/r3; contention open; the contending "accepted" instance `bff4aca1…` resolves to no content.
2. **model-use-cases** `sha256:24f0aff2…` — **never reviewed** at its own content address; the only UC reviewer verdict in the workspace (FR-Model-Use-Cases-001 `8aeee351…`, factory-testbed namespace) pins a different candidate `c6120e86…`; bundle authored in violation of its own desk upstream hold (UH-Model-Use-Cases-001 `6cccd162…`).
3. **derive-system-requirements** `sha256:86b00569…` — verdict **repair** (FR-001 `d31b044c…`) + restaff confirmation RS-001 `1c30d28e…` (confirms the verdict, not an acceptance); reviewer seat itself held (UH-001 `fbc0394b…`, UH-002 `b4eaaaba…`).

The only accepted base is the discovery import chain (`sha256:b10bb762…`): all 9 capsule sub-artifact digests recompute and match this desk task envelope 8/8 (+CERT-1 `03972527…`).

Also open: reviewer verdict contention CL-Define-Acceptance-Contract-001 (emission A repair vs concurrent emission B accepted with no status-layer audit) — routed to driver/human adjudication; and the governing anchor `a926df62…` remains unresolvable workspace-wide (recorded as envelope provenance, never ratified).

## Verification

`define-acceptance-contract-desk-hold-verify.mjs` — **45/45 recomputations pass** (`-hold-verify-out.json`): emitted digests, capsule/envelope re-derivation, all cited record digests + verdict pins, UC different-candidate pin, unresolvable-instance proofs, fence (no product material; prd:scope-2 never ratified), status-layer honesty (no accepted-state assertions), determinism (pinned timestamps, no clock/random).

## Resume contract (R1–R5)

Adjudicate the verdict/contention records by content address → intent desk reissues against the adjudicated basis (CRIT-1 remediated) → UC bundle `24f0aff2…` gets its reviewer stage → requirements link gets a verdict record for the revision this desk would consume → only then is this desk re-staffed and reissues the acceptance contract against genuinely accepted content addresses. This hold is not carried as product lineage.
