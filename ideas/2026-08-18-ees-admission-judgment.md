# Judgment (ultra-mode): factory atoms, the admission boundary, and the Engineering Execution System frame

- **Date:** 2026-08-18
- **Input:** `ideas/2026-08-18-kernel-surface-evidence-development-chain.md` (the evidence package)
- **Status:** a judgment for discussion. Not a normative document; not a replacement for an ADR.

---

## Verdict

Neither "generic atoms" nor "private machinery" — and that is the good outcome.

**The chain's machinery is already generic.** Fan-out is a `materialization` field on a
production cell, executed by the generic executor. The git candidate is the
factory-level `git-integration` effect with a CAS ledger, declared as a string.
Runnability is the factory-level `local-runnability` provider in `trusted_providers`.
Gates, recovery epochs, candidate sets, the authority commit, replay — all kernel.

**What is private to development is three kernel handlers** (resolve/freeze/bind) —
and they are not kernel mechanics but **the domain semantics of the material
"code"**: what a valid work graph is, what a frozen integrated candidate is, what
a runnability binding means. Each handler's body is subject-matter validation;
its shape — "validate and persist / observe and freeze / bind a receipt" — is
repeatable but small.

**What is missing is not an abstraction but admission.** A code-producing package
today must contribute: payload contracts into the closed
`workshop-capability-manifest`, a handler pack into `src/modules/<x>`,
registration in the composition root, and (when joining the chain) a lifecycle.
That is 3–4 kernel-repo edits. LEGO holds at the grammar level and has not been
carried through to the package-admission level. That is platform work, not an
architecture defect — and it already has an appointed home in the release ladder.

---

## 1. The atoms the factory is assembled from

Seven atom classes (all confirmed in code; see the evidence package §2):

| Atom | Role | Admission today |
|---|---|---|
| Flow node (5 kinds) | the structural unit of a flow | declarative |
| **Production Cell** | the universal unit of production: fan-out, author/reviewer, gates, recovery, post-acceptance effect | declarative |
| KernelHandler | deterministic coordination over ports | **in-repo** (registered by TS installation code) |
| CheckProvider | deterministic judgment (four-valued) | **closed manifest** (+ the `trusted_providers` trust ceremony) |
| PostAcceptanceEffect | factory-owned post-acceptance transformation (CAS ledger) | **closed manifest** |
| PayloadContract | the cross-process product decoder | **closed manifest** |
| Package | content-addressed declarative material (resources, schemas, skills, handler refs with digests) | declarative |

The assembly formula:

```
Workshop = Package + Cells (N, incl. fan-out) + KernelHandlers (K)
         + Capabilities (providers/effects/contracts) + Lifecycle binding
Factory  = kernel (executor/gates/authority/effects/recovery/replay) + M workshops + lifecycles
```

Development in these terms: 4 cells (2 fan-out + 2 singleton), 9 handler ids
(3 modules), 3 consumed factory capabilities, a content-addressed package.
Delivery — the same 4-node "prepare → act → observe → settle" shape with no code
and no new capabilities: the node shape is not the signature of code production.

## 2. The right metric — not size, not kernel-node count, but admission distance

**Admission distance** = how many deliberate kernel-repo edits a new workshop of a
given class requires. Measurable, monotonic, fits a ratchet.

| Workshop class | What it produces | Admission today | Proof |
|---|---|---|---|
| Tier 1 — text with review | narratives, documents | **0** | lm-marketing (17 files, zero runtime edits) |
| Tier 2 — deterministic computation | volumes, models, drawings via qualified providers | **1–2** (provider/effect code + manifest entries + a trust row) | the GDesign plan (femdriver/scad/normbase/cad/dockit as Check/EffectProviders) |
| Tier 3 — code | sources with a git candidate and runnability | **3–4** (payload contracts + handler pack + composition root + lifecycle) | development itself |

The key distinction inside admission: **Tier 2 is a trust ceremony** (qualifying a
deterministic provider — a legitimate and permanent boundary; four-valued
semantics makes an unqualified provider an honest `unknown`), while **Tier 3 is
admission of coordination code** plus that same trust ceremony — because a kernel
handler writes into the authority. Both procedures are currently materialized as
"a PR into the kernel repo".

## 3. What must move from development into the kernel: nothing — and why

1. **The mechanics are already in the kernel.** Everything that makes the chain
   possible (materialization, the git effect, the runnability provider, gates,
   the effect ledger, authority) lives in generic layers. There is nothing to move.
2. **The handlers are body, not shape.** The handlers' generic shape is small
   (tens of lines of skeleton); the body is subject-matter validation. Extracting
   a generic atom from a single consumer is forbidden by the project's own budget:
   "no new kernel abstraction until it has been exercised by the reference
   implementation and a second fixture" (Controlled Change Plane §8.1). N=1 is
   not a case for abstraction.
3. **The identity of admission is already built.** The manifests pin real sha256
   of installation modules (K3 done); `trusted_providers` carries
   `trust_basis=built-in:digest` with drift detection; binding receipts compare
   expected/resolved canonically. Only the source of admission is missing: a
   hardcoded list instead of a package declaration. That is opening a boundary,
   not a refactor.
4. **The normative path already knows this.** K14 ("compile module definitions
   into Production Cells") makes installation compiled; K19's non-goals assign
   the Domain Pack SDK to the Change Plane; C12 (Semantic Adapter SDK) is the
   appointed moment for opening admission, and its exit gate already demands a
   "minimal second fixture pack outside the kernel repository".

## 4. The EES product frame — and a correction to the original premise

The original premise: "if the code-production chain is private, EES is false for
everything that produces code — that is, for the main scenario." **The premise
misidentifies the main scenario.**

Per both strategy documents (FROM-SOFTWARE-FACTORY §5, GO-TO-MARKET §1–4), the
sold scenario is **expertise-ready calculation volumes**: the GDesign workshops
(Analysis/Normative/Drafting) produce models, checks, drawings and PDFs — not
code. Their kernel needs: fan-out over calculation items (Tier 1 grammar) +
qualified providers as CheckProviders/EffectProviders (Tier 2 — a trust
ceremony). **The git candidate and runnability are not on the main scenario's
critical path.** Code production is the factory's reference implementation (the
software factory itself), to be sold as a platform later (C12: "software remains
the reference pack").

The honest three-tier sales formula:

- **"A new workshop = kernel + different skills"** — true today for Tier 1 (text
  with review); proven by lm-marketing.
- **"…+ qualified providers"** — true today for Tier 2 (engineering volumes):
  qualification is an explicit trust ceremony, not a missing capability. This is
  the main product.
- **"…+ its own handler pack"** — for Tier 3 today it is "LEGO with a screwdriver"
  (one compiled PR adds the pack). It matures into a full package by C12. A
  second code-producing workshop arises only for a buyer who is a software team
  with a process *different* from the reference factory's — a rare, late case.

The asymmetry found is a real structural fact, but its business exposure is
bounded: it does not undermine the main scenario; it defines the platform
roadmap and the metric (admission distance) to drive selectively toward zero.

## 5. The migration path without stopping the factory

The sequence respects K0–K20 as the normative path (new domains prohibited until
M6) and the "one release — one guarantee" principle.

**Now (before M6) — three cheap actions, zero runtime changes:**
1. **ADR "Kernel admission boundary"**: fix the seven atoms, the three-tier
   admission model, the decision "do not extract generic atoms at N=1", and the
   second-consumer criterion. The closure owner of the registry entry is C12.
2. **An admission counter in a ratchet** (in the spirit of K2): an architecture
   test pinning the number of manual admission points — entries in
   `WORKSHOP_PAYLOAD_CONTRACTS` / `WORKSHOP_EXECUTABLE_CAPABILITIES`,
   `register*` calls in the composition root, lifecycle definitions in the start
   gate. Growth only by deliberate decision.
3. **The GDesign workshops as fixtures** (zero production runs) — the pilot is
   prepared without violating the prohibition.

**M6 → C0–C4:** no admission changes. C4 already delivers the change-plane
operational MVP.

**C12 — the moment admission opens** (with existing mechanisms, not new ones):
- the capability manifest becomes composite: kernel + package declarations of
  providers/effects with digests; cross-process parity is preserved by the
  existing binding-receipt mechanism (the expected/resolved comparison stays;
  only the source of "expected" changes);
- a handler pack = a compiled module with an implementation digest, admitted
  under the same pinning discipline the manifests already carry;
- the trust ceremony moves into data: `trust_basis=pack:digest` alongside
  `built-in:digest`; four-valued semantics is the safety net (`unknown ≠ passed`);
- the C12 exit gate ("a second fixture pack outside the kernel repository") is
  precisely the Tier-3 test.

**C13:** the engineering pilot — Tier 2 in production.

**The single behavioral leak found** (`linkType: 'implements'|'depends_on'` by
`workflowStage` in projection-persistence) — do not touch until K15 (its
"no module-name branching" invariant covers the case) or C5 (the trace model
owns edge types).

## 6. Counterarguments to keep in view (the steelman of "it is a defect")

1. If EES is sold to software teams before C12, the Tier-3 "screwdriver" becomes
   visible friction in demos. Mitigation: sell the reference factory as the
   product (not "add a workshop"), which is exactly what GTM prescribes.
2. Opening admission at C12 weakens the desync firewall — the main lesson of
   LIVE-REVIEW-004. Mitigation: parity remains enforced (receipts); only the
   list's source changes; the C12 conformance kit must include a negative
   cross-process drift test.
3. K14 ("compile module definitions") can balloon if admission-opening is folded
   into it. Mitigation: keep opening out of Wave 4 (core) and entirely in
   Change Plane Wave 5 — already recorded in K19's non-goals.
4. Trust in handler packs after opening: a handler writes into the authority.
   There is no middle ground — a pack is admitted whole by digest (as the
   built-ins are today) or not at all; a "partially trusted handler" is an
   oxymoron. Which means C12 packs pass the same tier-3/4 review as kernel
   releases.

---

## One-line summary

The kernel is already assembled from the right atoms; the work ahead is not
"move development's machinery into the kernel" but "make the admission ceremony
package-based while preserving parity and trust" — with an appointed date (C12),
ready-made mechanisms (digests, receipts, trusted_providers, four-valued checks),
and a metric (admission distance: Tier 1 = 0 kernel edits, Tier 2 = 1–2,
Tier 3 = 3–4; drive it to zero selectively) — and the main sold scenario
(engineering volumes) does not wait for this work.
