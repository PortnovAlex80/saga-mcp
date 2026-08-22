# ADR-083: Capability and readiness fingerprint contract (K19 commit 1 — the frozen contract)

- **Status:** Accepted (contract frozen; implementation is the K19 commit train, commits 2–6)
- **Date:** 2026-08-20
- **Owner:** K19 — Readiness and Toolchain Package Identity (SAGA-CORE-RENEWAL-PLAN §K19, milestone M5)
- **Extends:** ADR-077 (canonical runtime package fingerprint — extension rule: later
  releases ADD keyed components; this contract adds the toolchain component)
- **Stage-13 anchor:** STAGE-13-AGENT-BRIEF TASK 3 — "the environment in which a
  candidate is certified must be one immutable identity, derived from the
  artefact itself, shared by preparation and certification. The candidate's
  declaration becomes additive — it may add to the derived environment, never
  define it."

---

## 1. The defect this contract removes

Today the execution environment of a readiness check is the candidate's own
frozen declaration: `readiness.commands.installCommand` (the profile the
candidate submitted). Verified live (WORKSHOP-CONTROL-TRACKING §1, L1(b)): the
GDesign run declared `pip install numpy PyMuPDF openpyxl pytest`, the code
imported `yaml`, the sterile container had no `pyyaml`, the run failed
honestly at L0.

This is the third instance of one disease (CONVEYOR §30.1): **a frozen
prediction enforced as authority**. The scope fence guessed paths; the
install declaration guesses packages; the test declaration guesses checks.
A guess about not-yet-executed work cannot obligate reality — the same
sentence, the third costume.

## 2. The contract

### 2.1 One environment identity, derived, shared

The environment in which any readiness evidence is produced or certified is
ONE immutable identity:

```text
DerivedExecutionEnvironment {
  environmentDigest          // sha256 over the canonical derivation (2.2)
  baseImageDigest            // OCI image digest (sha256:…), never a floating tag
  toolchain: [               // ordered, deduplicated
    ToolClaim { logicalName, versionConstraint, implementationDigest }
  ]
  dependencyLockDigest       // content digest of the EXACT resolved lock material
  filesystemLayoutDigest     // paths the environment promises to exist
  networkPolicy              // hermetic | named-egress(…), never implicit
}
```

The SAME `environmentDigest` binds both halves of the lifecycle:

```text
preparation   (ephemeral environment materialization)
certification (post-integration readiness cell)
```

Drift between the two halves is a typed incompatibility, never a re-run with
different bytes.

### 2.2 Derivation, not declaration

`environmentDigest` is DERIVED from the artefact and the pinned factory
package — the exact integrated source tree (imports/entrypoints/lockfiles
as declared in the tree), the pinned package's own toolchain requirements,
and the base image digest. The candidate's declaration is ADDITIVE: it may
add tool claims and constraints the derivation did not find; it may NEVER
remove, replace, or narrow a derived claim. A declaration that contradicts
the derivation fails closed at freeze time with a typed
`ENVIRONMENT_DECLARATION_CONTRADICTS_DERIVATION` — before any container
starts.

### 2.3 Tool identity = implementation identity

A tool claim carries `implementationDigest` — the digest of the exact
executable artifact (wheel/sdist hash, OCI layer digest, binary sha256).
The same logical name with a changed implementation digest is a DIFFERENT
environment (K19 invariants; tested by train commit 5). Aliases that erase
implementation identity are forbidden.

### 2.4 Fingerprint extension (ADR-077 rule)

`RuntimePackageFingerprint` gains one keyed component — never reorders or
removes existing ones:

```text
sha256Hex(canonicalJson({
  …existing ADR-077 components…,
  toolchainDigests: { logicalName, implementationDigest }[]
}))
```

Resume compatibility: a package whose toolchain component changed is
resume-INCOMPATIBLE (the environment it would rehydrate is not the
environment that produced prior evidence).

### 2.5 Evidence classes

Every readiness fact is one of: TOOL (claimed and RESOLVED to an
implementation digest), CONTAINER (image digest observed, not assumed),
ENVIRONMENT (the derived identity of 2.1), LICENSE (the license terms the
toolchain imposes on the produced artefact, carried as evidence —
license-incompatible toolchains are a human-required boundary, not a silent
pass), VALIDATOR (the versioned payload validator that checked the
readiness manifest itself). Each class names its evidence refs; none is
prose.

### 2.6 Certification is a Production Cell

Post-integration readiness certification is an ordinary Production Cell
(CONVEYOR §4): immutable CheckReceipts against the exact accepted subject
(candidate hash + integrated commit/tree + environmentDigest), never
against a "latest" anything. The readiness cell declares the
`DerivedExecutionEnvironment` as its required environment; the cell cannot
run under a different environment identity than the one recorded on the
receipt it issues.

### 2.7 Isolation

Environment preparation is ephemeral and disposable (venv/container per
materialization; no shared mutable venv authority — train commit 2). Two
concurrent preparations of the same identity converge to identical
filesystem layouts; nothing persists between them except
content-addressed artifacts.

## 3. What this contract forbids

- an install command, environment, or check set DEFINED by the candidate
  (additive only — CONVEYOR §30.1);
- a floating image tag or unversioned tool name anywhere in an environment
  identity;
- preparation and certification observing different environment digests;
- reusing readiness evidence across changed toolchain implementation
  digests;
- a readiness receipt whose subject does not bind candidate + tree +
  environment in one identity.

## 4. Commit-train mapping (K19, §K19)

| # | Commit | Builds | Status |
|---|---|---|---|
| 1 | `docs(architecture): freeze capability and readiness fingerprint contract` | THIS ADR | **landed** |
| 2 | `refactor(readiness): isolate readiness in ephemeral environments` | §2.7 | **core landed (stage-14)** — per-attempt isolation already held (temp-dir extraction + disposable venv per check, no shared mutable state); stage-14 added the derivation core below. The full ephemeral-OCI substrate matrix remains open. |
| 3 | `refactor(environment): one exact environment per pinned package, digests persisted` | §2.1/2.2/2.3 | **core landed (stage-14)** — `environment-derivation.ts`: the environment is DERIVED from the sealed artefact (import scan vs manifests vs declared install), the declaration is additive (install augmented with the gap, same runner), undeclared needs with no install to augment fail closed typed (`ENVIRONMENT_DERIVATION_UNDECLARED_NEED`) BEFORE any spawn, and `environmentDigest` rides every outcome as a decodable diagnostic (preparation and certification hold one identity). NOT done: per-package OCI image/dependency digest persistence in the package store, and the ADR-077 fingerprint's keyed `toolchainDigests` component. |
| 4 | `refactor(certification): make post-integration readiness a Production Cell` | §2.6 | not started |
| 5 | `test(readiness): prove environment drift invalidates compatibility` | §2.3/2.4 | partial — the domain-free GDesign negative (derivation catches the undeclared import pre-spawn) landed with the stage-14 core; image/digest drift invalidation not started |
| 6 | `docs(core): close readiness ADR cohort` | registry closure | not started |

Release-discipline budget (plan §3): ≤ 25 production files, ≤ 6 per commit,
≤ 1 schema migration family — applies to the train as a whole.

## 5. Boundary statement (stage-13 TASK 3, updated by stage-14 TASK 1)

Stage 13 executed the train in order and stopped at commit 1. Stage 14
landed the CORE of commits 2–3 (derivation, additive declarations,
fail-closed undeclared needs, the one identity riding every outcome — see
the table above for exactly what that core includes and what it does not).
Commits 4–6 are not started; the OCI digest-persistence surface of commit 3
and the ADR-077 `toolchainDigests` extension remain open. A fraction is not
presented as the whole: the negative test that decides the core
(the domain-free GDesign reproduction — `orbital-mechanics`, an invented
package, no Python, no pyyaml) passes, and everything not done is named.

## 6. Boundary note — environment identity vs availability vs receipt-binding (2026-08-22, conformance-closure sixth pass)

The Conformance Closure substrate seams (CC-GAP-7/CC-GAP-9, ADR-089)
must not drift into this contract's ownership. The split is normative:

- **ADR-083/K19 owns environment IDENTITY — declared, observed, and
  authorized.** The `DerivedExecutionEnvironment`, `environmentDigest`,
  `baseImageDigest`, toolchain `implementationDigest` identities, and
  the floating-tag prohibition (§3) are defined and authorized here and
  nowhere else.
- **CC-GAP-9 owns environment AVAILABILITY only.** Whether the
  declared/authorized environment can be materialized (for example
  Docker unavailable) is a CC-GAP-9/ADR-089 concern: bounded
  deterministic in-check substrate retry, then the typed unknown
  `warrant-blocked-environment` and a `human_required`
  blocked/resumable continuation. CC-GAP-9 never defines, redefines, or
  authorizes environment identity.
- **CC-GAP-7 CONSUMES and receipt-binds; it never authorizes.** Warrant
  execution consumes the `environmentDigest` and the readiness receipt
  binds the digest it ran under (§2.6 exact-subject receipts). CC-GAP-7
  never issues, blesses, or substitutes an environment identity.

Sequencing and honest fallback: the K19 image/digest remainder (the
open items of train commits 3 and 5 — per-package OCI image/dependency
digest persistence in the package store and the ADR-077 keyed
`toolchainDigests` component) is sequenced BEFORE CC-GAP-7
receipt-binding. If it has not landed when CC-GAP-7 starts, the honest
fallback applies: CC-GAP-7 binds the `environmentDigest` the stage-14
derivation core already produces (it rides every outcome as a decodable
diagnostic) and records honestly in the receipt and its evidence that
image and dependency digest persistence is not yet available. The
fallback never fabricates a digest, never treats an unauthorized
identity as authorized, and never admits a floating tag (§3 stands
unconditionally).
