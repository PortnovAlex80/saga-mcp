# import-discovery-handoff desk — reviewer submission summary (stray-products-r2)

**Desk:** import-discovery-handoff (reviewer role)
**Round:** stray-products-r2
**Verdict:** `accepted` (frozen vocabulary: accepted / repair / upstream-repair / human-wait / terminal-reject)
**Reviewed candidate:** `FS-Import-Discovery-Handoff-002` — artifact `DI-Import-Discovery-Handoff-001` (`sha256:b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5`), author trace `sha256:2e5bb8ce3f26de726729c107760d43d5c81350b1a412f5c504d95352a0ef8274`
**Envelope consistency:** 8/8 task-projection content addresses resolved (id + digest byte-exact); workspace law `0 accepted upstream revisions travel by content address` consistent everywhere.

## What the reviewer did (nothing trusted by declaration)

Independent recomputation of **every** declared digest under the frozen kernel rule
(`sha256` over canonical JSON — recursively key-sorted, compact — per
`src/workflow-kernel/domain/digest.ts`): **41 checks, 41 passed, 0 failed.**

1. **Self-addresses.** Submission, discovery-import artifact and author trace each
   re-verify: recomputed digest equals the declared `contentDigest`, and the
   `sha256:` ref equals the content address of that digest.
2. **Sub-artifacts.** All 9 capsule members (certificate, SC-1..SC-4, CON-1, UNK-1,
   TC-1, TC-2) recompute over their canonical content. The author's
   `declaredDigestsTrusted: false` claim is honest.
3. **Envelope ↔ capsule.** All 8 reviewer-frame content addresses
   (`claim:scope-1/2`, `claim:constraint-1`, `claim:outcome-1`,
   `constraint:retention-1`, `unknown:browser-matrix-1`, `terminal:audited-1`,
   `terminal:delivered-1`) match the recomputed digests exactly — no digest drift,
   no silent drops (WP-18). The r1-round disease (CRIT-003: fabricated digests,
   e.g. the non-hex `...g8h0i2j4...` refs) is absent this round.
4. **Capsule self-address.** Recomputed over the canonical fact body in
   `ingress.ts` order from the recorded facts: equals `f3f98175...a0534e`.
   Protocol version is the pinned `ek.discovery-handoff-capsule.ek8-wp11f.v1`;
   parent state is the one legal producer state `discovery-terminal` with a
   content-addressed terminal proof ref.
5. **Trace graph.** All 11 author relationships resolve against recomputed
   digests; terminal coverage blocks equal the edge sets exactly; both terminals
   are reached by all 4 source claims + the constraint; the unknown
   (`unknown:browser-matrix-1`) is carried forward with `owner: discovery` and no
   fake resolution edge (D10 law).
6. **Payload contract.** The 11 `requiredEvidenceRefs` are the exact expected set
   (capsule, certificate, 4 claims, constraint, unknown, 2 terminal claims,
   governing contract); kind coverage counts match 1:1.
7. **Constraint + workspace.** `constraint:retention-1` (deterministic content)
   honored in author and reviewer artifacts alike (pinned timestamps, no clock
   reads); desk writes stayed within desk-artifact authority.

## Findings

**Critical/major:** none.

**Advisories (recorded, non-blocking):**
- **Package bytes attestation.** Raw capsule package bytes are not present in the
  desk workspace. `packageBytesDigest` is well-formed and the capsule self-address
  recomputes, but `BYTES_MISSING`/`BYTES_CORRUPT` are kernel ingress authority
  (driver-executed over public commands, attested by the desk intake receipt).
  Recorded as attestation, not desk-level re-verification.
- **Discovery-side refs not locally resolvable.** `lineage.parentLifecycleRef`
  (`sha256:0794e660...`) and `parentState.terminalProofRef` (`sha256:4a919f52...`)
  are well-formed content addresses of Discovery state. Textual consistency
  checked: lineage `lineage:message-service-2026-08` matches certificate subject.
- **TC-2 wording quirk.** `terminal:delivered-1` statement duplicates the TC-1
  template wording ("triaged go with recorded strengths"). Content address is
  honest; desk transports capsule content verbatim — flagged to the discovery
  owner for template hygiene only.

## Reviewer artifacts emitted (all content-addressed, digests recomputed at build)

| Artifact | Ref |
|---|---|
| Review (`FR-Import-Discovery-Handoff-002`) | `sha256:cfc7b35a5d0b71586e24be6474c5add914ba5f303edbd8bc2789782fd34b4d7b` |
| Reviewer trace (`RT-Import-Discovery-Handoff-002`) | `sha256:a2cba0ffed35694b82a8f2c45e042df2360726c3910d41d5f7533f894c61d8ad` |
| Verification evidence (41/41) | `sha256:b8a00be93d977bf94c93c68cd712b05696b0f472e1db1e91612fece401bc8d70` |
| Reviewer product submission (`FS-Import-Discovery-Handoff-003`) | `sha256:0155d0cb90b6744356a0bc5d4186bda72f94c5e45bdde2877c1a3313b01ed470` |
| Reproducible verifier | `import-discovery-handoff-desk-reviewer-verify.mjs` (plain `node`, no deps) |

## Next steps

1. Final gate (`workplace.runFinalGate`) consumes the reviewer verdict `accepted`.
2. Shell desk settles (`formalization.accept-products`); the verified capsule
   (capsule ref `sha256:f3f98175...a0534e`) stands as the shell-stage material
   authority for the formalization stage.
3. Forward the TC-2 wording advisory to the discovery owner.
