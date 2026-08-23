# ADR-083: Capability and readiness fingerprint contract (K19 commit 1 — the frozen contract)

- **Status:** Accepted (contract frozen at `f05dd37e`; implementation is
  the K19 commit train — the commits 2-3 derivation CORE landed at
  `5e39946a`; the receipt-fence image/dependency identity remainder landed
  with provider `factory.local-runnability.v1` @ `1.13.0` (registry manifest
  digest + dependency lock identity bound into the receipt fence); the
  post-REJECT repair landed as `1.14.0` — atomic one-snapshot image
  observation (paired RepoDigests+Id facts, immutable-id tagging), the
  provider-boundary baseImageDigest fence (typed product failure, never
  passed/unknown/retried), and the exact version→digest trust migration (a
  forged basis on a known legacy version is drift, never laundered); the
  package-store digest persistence, the ADR-077 keyed `toolchainDigests`
  component, and commits 4-6 remain open; K19 is not complete)
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
| 1 | `docs(architecture): freeze capability and readiness fingerprint contract` | THIS ADR | **landed (`f05dd37e`, stage-13)** |
| 2 | `refactor(readiness): isolate readiness in ephemeral environments` | §2.7 | **core landed (`5e39946a`, stage-14)** — per-attempt isolation already held (temp-dir extraction + disposable venv per check, no shared mutable state); `5e39946a` added the derivation core below. The full ephemeral-OCI substrate matrix remains open. |
| 3 | `refactor(environment): one exact environment per pinned package, digests persisted` | §2.1/2.2/2.3 | **core landed (`5e39946a`, stage-14)** — `environment-derivation.ts`: the environment is DERIVED from the sealed artefact (import scan vs manifests vs declared install), the declaration is additive (install augmented with the gap, same runner), undeclared needs with no install to augment fail closed typed (`ENVIRONMENT_DERIVATION_UNDECLARED_NEED`) BEFORE any spawn, and `environmentDigest` rides every outcome as a decodable diagnostic (preparation and certification hold one identity). **Receipt-fence identity remainder landed (`1.13.0`)**: `baseImageDigest` §2.1 is now real at the readiness receipt — `DockerReadinessExecutor.prepare` resolves the declared image to its OCI REGISTRY MANIFEST DIGEST from RepoDigests (never a floating tag, never the local image id, which stays provenance-only in `resolvedBaseImageId`) and fails closed typed BEFORE any build on missing (locally built/loaded image), malformed, repo-mismatched (substituted), ambiguous (stale/divergent) or pin-mismatched evidence (`ENVIRONMENT_IMAGE_IDENTITY_*`); the derivation binds `dependencyLockDigest` (sha256 over the sealed tree's exact lock material — lock drift is a different `environmentDigest`); both identities ride every observation and bind the deterministic `local-readiness:<digest>` receipt fence (provider digest policy keys `imageIdentityPolicy`/`dependencyLockPolicy`). Identity failures are product `failed` — K19 owns identity, ADR-089/091 own availability (§6 split), so identity codes never enter the substrate retry. STILL NOT done: per-package OCI image/dependency digest persistence in the package store, and the ADR-077 fingerprint's keyed `toolchainDigests` component. |
| 4 | `refactor(certification): make post-integration readiness a Production Cell` | §2.6 | not started |
| 5 | `test(readiness): prove environment drift invalidates compatibility` | §2.3/2.4 | **receipt-level drift proofs landed (`1.13.0`)** — `tests/infrastructure/environment-identity.test.mjs`: lock drift changes `environmentDigest` (never a reused identity); a substituted registry manifest digest changes the content-addressed receipt (the fence detects image substitution, holding the subject constant); the fail-closed battery covers missing/malformed/substituted/stale/pin-mismatched image evidence; the §6 split ratchet proves an identity failure is product `failed`, never the substrate unknown. The ADR-077 `toolchainDigests` resume-incompatibility proof remains not started. |
| 6 | `docs(core): close readiness ADR cohort` | registry closure | not started |

Release-discipline budget (plan §3): ≤ 25 production files, ≤ 6 per commit,
≤ 1 schema migration family — applies to the train as a whole.

## 5. Boundary statement (stage-13 TASK 3, updated by stage-14 TASK 1; commit-grounded seventh pass; eighth pass records the receipt-fence identity remainder; ninth pass records the 1.14.0 post-REJECT repair)

Stage 13 executed the train in order and stopped at commit 1
(`f05dd37e` — THIS contract freeze, the only K19 commit it landed).
Stage 14 landed the CORE of commits 2–3 in ONE commit (`5e39946a`,
"K19 commits 2-3 core — the derived execution environment": derivation,
additive declarations, fail-closed undeclared needs, the one identity
riding every outcome). The receipt-fence identity remainder (provider
`1.13.0`) then realized `baseImageDigest` at the readiness receipt: the
OCI registry manifest digest resolved from RepoDigests (fail-closed on
missing/malformed/substituted/stale/pin-mismatched evidence, before any
build) and the `dependencyLockDigest` over the sealed tree's exact lock
material, both bound into the deterministic receipt digest. The `1.14.0`
post-REJECT repair hardened that slice on three proven blockers: the
base-image identity is now observed ATOMICALLY (ONE `docker image inspect`
snapshot; RepoDigests and the local Id are paired facts of the same
response; only the immutable Id of that snapshot is tagged — a tag switch
between two resolutions of the mutable declared tag can no longer pair A's
manifest digest with B's local id), the provider boundary fails closed
typed when a docker description reaches the receipt without a well-formed
sha256 `baseImageDigest` (product `failed`, never passed/unknown/retried),
and the `trusted_providers` migration requires the exact
version→built-in-digest pair of the shipped lineage (a forged basis on a
known legacy version is `LOCAL_RUNNABILITY_TRUST_POLICY_DRIFT`, never
laundered). Commits 4–6 are not started; per-package digest persistence in
the package store and the ADR-077 `toolchainDigests` extension remain
open, and the local image id remains provenance-only
(`resolvedBaseImageId`), never identity. A fraction is not presented as
the whole: the negative tests that decide each slice pass (the domain-free
GDesign reproduction at
`tests/infrastructure/environment-derivation.test.mjs`; the identity
battery at `tests/infrastructure/environment-identity.test.mjs`; the
atomic-observation battery at
`tests/infrastructure/environment-image-observation.test.mjs`), and
everything not done is named.
**K19 is NOT complete** — `f05dd37e` + `5e39946a` + the `1.13.0`
receipt-fence identity remainder + the `1.14.0` post-REJECT repair are
commit 1, the commits 2-3 core, and the digest/observation slices of
commits 3/5 only; package-store persistence, the ADR-077
`toolchainDigests` component, and commits 4-6 remain open work.

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
receipt-fence identity slice of train commits 3 and 5 — the OCI registry
manifest digest and the dependency lock identity bound into the readiness
receipt — landed with provider `1.13.0`) is sequenced BEFORE CC-GAP-7
receipt-binding. The STILL-OPEN remainder (per-package OCI
image/dependency digest persistence in the package store and the ADR-077
keyed `toolchainDigests` component) keeps its honest fallback: if it has
not landed when CC-GAP-7 starts, CC-GAP-7 binds the identities the
landed core already produces (the `environmentDigest` and
`dependencyLockDigest` riding every outcome, plus `baseImageDigest` on
docker-substrate receipts) and records honestly in the receipt and its
evidence that package-store digest persistence is not yet available. The
fallback never fabricates a digest, never treats an unauthorized
identity as authorized, and never admits a floating tag (§3 stands
unconditionally).
