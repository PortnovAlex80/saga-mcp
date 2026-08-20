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
| 2 | `refactor(readiness): isolate Python readiness in ephemeral environments` | §2.7 | not started |
| 3 | `refactor(environment): prepare one exact OCI environment per pinned package` | §2.1/2.2/2.3 | not started |
| 4 | `refactor(certification): make post-integration readiness a Production Cell` | §2.6 | not started |
| 5 | `test(readiness): prove environment drift invalidates compatibility` | §2.3/2.4 | not started |
| 6 | `docs(core): close readiness ADR cohort` | registry closure | not started |

Release-discipline budget (plan §3): ≤ 25 production files, ≤ 6 per commit,
≤ 1 schema migration family — applies to the train as a whole.

## 5. Boundary statement (stage-13 TASK 3)

Stage 13 executes the train IN ORDER and stops at a clean boundary. This
ADR is commit 1 and a clean boundary: the contract is frozen, extends the
accepted ADR-077 rule, and nothing downstream (commits 2–6) has been
started or is claimed. A fraction is not presented as the whole.
