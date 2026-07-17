# Test Pyramid, Code Quality Tooling, and the LLM Verifier in saga-mcp

> **Source:** research agent run 2026-07-17, subagent `agent_718656d4`.
> **Ground:** ADR-007 post-convergence state. REQ-008..013 shipped — 4-valued outcome, provider column, runtime_observations, task_conflict_keys are real.

## Executive summary

Today exactly one provider identity is wired in (`test_runner`, via verification.ac task re-running Builder's tests). Everything else in the test pyramid (compile, lint, schema, property, benchmark, SAST, dependency) exists only as descriptive language in CGAD §6.1.

**Headline findings (priority order):**

1. **Current AC-verification task is NOT independent** — it greps for Builder-written test tagged with AC code and re-runs it. Builder evidence under Verifier hat. CGAD §9/P7/§22-#39 forbid. cgad-spec-lint R9 catches obvious form (same recorded_by) but not subtler (different agent, same test).
2. **Trusted Provider Registry explicitly listed "Descriptive — future REQ if provider misuse becomes a pain" in ADR-007.** The task at hand is *that* pain.
3. **L2-vs-L3 inversion is real but partial:** property tests carry more signal per token under LLM-runtime, but only for ACs whose criterion is a *relation/invariant*. For UI ACs, example/E2E still only option. Pyramid doesn't uniformly shift; it bifurcates.
4. **No `test_layer` field on verification_evidence, no enum on provider.** Both needed before saga can route verification.ac to right runner.

---

## 1. Test pyramid under LLM-runtime

### 1.1 Classical pyramid and what it optimized for

Cohn/Fowler pyramid (many unit / fewer integration / rare e2e) is cost-optimization under:
- Human execution time per test
- Human maintenance cost per test
- Human flake-tolerance

Ratio 70/20/10 emerges from marginal-cost argument.

### 1.2 LLM-runtime moves cost from writing to trusting

| Cost axis | Classical | LLM-runtime |
|---|---|---|
| Write a test | minutes, by human who knows system | seconds, by agent that may not |
| Maintain | minutes, refactored with code | seconds, agent rewrites both atomically |
| Detect wrong test | peer review by human who knows system | **HARD — wrong test and wrong code written by same agent, against same (possibly wrong) mental model** |
| Flake tolerance | low (human triage) | same, but agent will cheerfully "fix" flakes by adjusting test |

**New dominant cost:** LLM writes tests against LLM-written code, both can be wrong in same way, tests pass while system is wrong. Failure mode transposed: under humans "didn't write enough tests"; under agents "tests we have all encode same wrong assumption."

### 1.3 Mapping pyramid onto CGAD §14 contract levels

| CGAD level | Checks | Classical slot | Example |
|---|---|---|---|
| L0 Compilation | types, visibility, cycles | build step | `tsc --noEmit`, `cargo check` |
| L1 Structural | schemas, formats, versions | contract/golden | OpenAPI, JSON Schema, DB DDL |
| L2 Behavioral | examples, golden, GWT | unit + integration bulk | AC "100000@12%/12m → 112682.50" |
| L3 Property | invariants, idempotence, metamorphic | rare; common in FP/formal | "compound(P,r,t) >= simple(P,r,t) for all positive r" — **not in any saga AC today** |
| L4 Operational | latency, error rate, throughput | rarely automated; load tests | AC "расчёт ≤ 50 ms" |

Classical "unit" spans L0+L1+L2. "Lots of unit tests" = lots of L2 example tests on top of cheap L0/L1 from compiler.

### 1.4 Hypothesis: agent-runtime shifts pyramid toward L3. Is it true?

**(a) True for algorithmic ACs.** When criterion is formula/invariant, property test expresses contract more compactly and honestly than 5 example tests. Cannot be faked by LLM that wrote function wrong in same way it wrote example test wrong — property is derived from contract (monotonicity, positivity, identity), not from running function once.

**(b) False for UI/structural ACs.** ACs like "warning text visible", "responsive at 320-768px" are examples by nature — no invariant to express. LLM-runtime just makes writing example cheaper; trust problem unchanged.

**(c) Untested for operational ACs (L4).** AC "расчёт ≤ 50 ms" confuses L4 operational claim with L2 example test. Honest provider = benchmark runner producing runtime_metric observation, NOT passed/failed evidence row.

### 1.5 Evidence within saga corpus (negative but telling)

- `grep "property test|Hypothesis|QuickCheck"` across docs/ returns matches only in CGAD spec and cgad skill — **zero saga AC documents mention property tests**, despite REQ-003 having textbook candidates.
- REQ-003-deposit-calc AC: "minimum 5 input datasets" — 5 example inputs is precisely classical-pyramid instinct, applied by agent, to AC better served by one Hypothesis strategy.

### 1.6 Recommendation: planner per-AC output

Add `test_layer` tag to verification task, chosen by shape of AC's criterion. **Require at least two layers per non-trivial AC:**

| AC shape | dev-task evidence | verification.ac evidence |
|---|---|---|
| Formula / algorithm | L2 example (Builder) | **L3 property (Verifier, independent)** |
| Structural / schema | L1 schema test | L1 schema-evolution check against frozen snapshot |
| UI / DOM / locale | L2 example | L2 example with independently-chosen inputs |
| Performance / latency | (Builder cannot self-certify L4) | **L4 observation via benchmark provider** |

**Principle: Verifier's layer differs from Builder's wherever possible.** Wrong LLM cannot simultaneously fool L2 example test AND L3 property test derived from same contract.

---

## 2. Code linters as Trusted Guard Input Providers

### 2.1 Which linters matter

| Provider | Layer | Asserts | Determinism |
|---|---|---|---|
| `tsc --noEmit`/`cargo check`/`mvn compile` | L0 | types resolve, no cycles, visibility | full |
| ESLint, Rubocop, Pylint, golangci-lint | L0+L1 | syntactic + structural rules | full given frozen config |
| Prettier, black, rustfmt | none (formatting) | diff is empty | full |
| TypeScript isolatedDeclarations, Rust `#![deny(unsafe)]` | L0+L1 | API-export shape, unsafe absence | full |
| `ajv` / JSON Schema validator | L1 | payload matches schema | full |
| `openapi-diff`, `cargo-semver-checks` | L1 | schema evolution backward-compatible | full |

All produce 4-valued verdict naturally: exit 0 (PASS), non-zero with findings (FAIL), file missing (UNKNOWN), crash (ERROR).

### 2.2 Wiring today vs how it should be

Today: agent runs linter in shell, reads exit code, *if passes* calls verification_record({provider:'test_runner'}). **Two problems:**
1. `provider` value is a lie — `test_runner` is not what ran; `tsc` ran
2. Outcome is self-attestation — agent read exit code and reported it

Right wiring: **wrapper tool per provider** that agent invokes instead of shell, which itself writes verification_evidence row:

```
verify_with_provider({
  provider: 'tsc',
  command: 'tsc --noEmit',
  artifact_id: <AC-id>,
  task_id: <verify-task-id>,
})
```

Agent never touches outcome value. From agent's perspective, provider IS the wrapper.

### 2.3 The provider registry problem

ADR-007: "Trusted Provider Registry as separate table — Descriptive — provider is free-form string; registry not modeled. Future REQ if provider misuse becomes a pain."

**Misuse now visible:** cgad-spec-lint R1c reports provider IS NULL, but cannot report `provider = 'i-made-this-up'`. Agent wanting to soften guard can invent `provider: 'code-review'` and write outcome:'passed'.

### 2.4 Should `provider` be CHECK enum? NO.

1. Closed enums block extension — every new linter requires schema migration
2. Different projects use different linters — Rust has clippy, Python has bandit, TS has neither
3. Trust basis is what matters, not name

**Right structure: registry table + foreign key:**

```sql
CREATE TABLE IF NOT EXISTS trusted_providers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER REFERENCES projects(id),  -- nullable = global
  category        TEXT NOT NULL CHECK (category IN (
                    'deterministic_evidence','authoritative_state','authorized_decision')),
  name            TEXT NOT NULL,
  trust_basis     TEXT NOT NULL,
  determinism     TEXT NOT NULL CHECK (determinism IN ('full','partial','none')),
  scope           TEXT NOT NULL,
  layer           TEXT,  -- CGAD §14: L0-L4
  version         TEXT,
  config_path     TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','deprecated')),
  registered_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, name)
);
```

CHECK on category IS enum (3 values, CGAD §6.1/6.2/6.3). Names open. Trust basis structured free text.

### 2.5 Registration mechanism

1. **Project bootstrap** — saga-start reads repo tooling (.eslintrc, tsconfig.json, pyproject.toml), pre-registers deterministic providers it can detect
2. **Manual** — provider_register MCP tool for human_approval, oracle_acceptance, custom linters
3. **Auto-derived** — if verification_record arrives with provider not in registry, accepted but flagged `provisional` until human confirms

Two new lint rules:
- **R13** — provider not in trusted_providers.name (warning, provisional)
- **R14** — provider exists but trust_basis doesn't match guard's required category (error — human approval cannot discharge Deterministic Evidence)

---

## 3. Static analyzers / SAST

### 3.1 Linter vs static analyzer

| Tool | Layer | Finds |
|---|---|---|
| Semgrep | L1 (structural patterns) | known-bad patterns across files |
| CodeQL | L1+L3 (data-flow + property) | taint flows, injection sinks |
| SonarQube | L1+L4 (quality gates) | complexity, duplication, coverage, security |
| Bandit | L1 (Python security) | common Python vulns |
| Brakeman | L1 (Rails security) | Rails-specific vulns |

### 3.2 Integration: risk escalation, not evidence

Non-obvious point: SAST should trigger `derived_risk` escalation, not just produce evidence.

Per CGAD P15, task touching security boundary has policy_minimum=high. Today fires only if task tagged `security`. Dev task unknowingly introducing SQL injection (not tagged) won't escalate.

Right loop:
1. Builder finishes
2. `verify_with_provider({provider:'semgrep'})` runs (mandatory at dev-task review gate)
3. If Semgrep finds security-category finding, wrapper rewrites task.derived_risk to high/critical
4. Recomputed final_risk forces high-risk guard set
5. Transition fails: "Semgrep finding #N escalated derived_risk"

### 3.3 Can SAST replace human security review?

**No.** SAST raises floor (catches obvious stuff deterministically) but doesn't move ceiling (architectural/authorization review still needs human or Verifier with contract-level understanding). For agent-written code specifically matters more — failure mode is "plausible-looking but subtly wrong" — exactly what SAST weak at, property test strong at.

---

## 4. Security scanners (dependency / supply chain)

### 4.1 Different category

Snyk, Dependabot, npm audit, pip-audit, OSV, cargo audit are NOT code analyzers. They consult vulnerability database against resolved dependency graph. Different CGAD category:

- Code linters/SAST → **Deterministic Evidence** (§6.1) — fact about code
- Dependency scanners → **Authorized Decision** (§6.3) — decision originating outside code (vulnerability DB curated by humans)

| Finding | CGAD category | Effect |
|---|---|---|
| Critical CVE in direct dependency | Authorized Decision (block) | Transition fails; requires security_exception_approval |
| High CVE direct | Authorized Decision (block) | Same, cheaper exception |
| Low transitive | Deterministic Evidence (informational) | Recorded as outcome:'unknown'; doesn't block but raises derived_risk if touches security boundary |

### 4.2 Concrete wiring

Scanner finding does NOT write verification_evidence with outcome:'failed'. Writes:
- `observation_record` (REQ-011) with observation_type:'incident' (or new dependency_finding type)
- AND sets `task_conflict_keys` entry of type `dependency` (v2 key type) blocking transition until dependency bumped or security_exception_approval recorded

### 4.3 Drift problem unique to dependency scanning

Verdicts **decay**. Scan that passed last week can fail today (new CVE disclosed). `trusted_providers` needs `freshness_window_days` column. cgad-spec-lint **R15** flags evidence rows whose provider requires freshness and created_at is stale.

---

## 5. Benchmark / canary / runtime observation

### 5.1 What exists

REQ-011 shipped runtime_observations + observation_record/observation_list. P17 enforced structurally. Gap = what feeds it.

### 5.2 Missing: wire-in to actual runners

| Runner | Produces | Layer |
|---|---|---|
| pytest-benchmark | per-function min/max/mean/stddev | L4 |
| locust/wrk/k6 | RPS, p50/p95/p99 latency | L4 |
| py-spy/async-profiler | flamegraph + hotspot | L4 informal |
| cargo bench/criterion | regression detection vs baseline | L4 |
| Lighthouse/web-vitals | p75 LCP/CLS/INP | L4 frontend |

**Unifying shape:** wrapper parses runner's structured output, writes observation; agent never types the number. Same tool as linter wrapper, differing only in which table writes.

### 5.3 Observation ≠ evidence — keeping separate

Temptation: "AC says ≤50ms; measured 42ms; therefore PASS." Category error:
- 42ms = Observed truth (fact about run)
- ≤50ms = Declared truth (fact about contract)
- PASS = Implemented-truth verdict — requires guard comparing observation to threshold

Guard is itself Deterministic Evidence provider (`benchmark_threshold`), distinct from benchmark runner:

```
1. observe_with_provider({provider:'pytest-benchmark'})
   → runtime_observations: observed_value='42ms', baseline_value='45ms'
2. verify_with_provider({provider:'benchmark_threshold', command:'compare...'})
   → verification_evidence: outcome='passed' (42ms ≤ 50ms)
```

Two rows, two tables, two providers. First cannot admit transition; second can.

---

## 6. Test runner diversity + test_layer field

### 6.1 Hidden assumption

Today's saga assumes "test runner = pytest or jest". Visible in saga-worker SKILL ("run the project's tests/lint"), verification.ac task ("find the test, run it"). assertVerificationPassed gate is provider-agnostic (feature, not bug) but AC-verification task is provider-specific.

### 6.2 Actual diversity

| Layer | Runner | Output |
|---|---|---|
| L0 | tsc --noEmit, cargo check | exit code |
| L1 | ajv, openapi-diff | exit code + diff |
| L2 | pytest, jest, go test | per-test PASS/FAIL |
| L3 | hypothesis, fast-check, proptest | per-property PASS/FAIL + shrinking |
| L4 | pytest-benchmark, locust, criterion | measured values |
| L1 security | semgrep, bandit | findings list |
| graph | osv-scanner, npm audit | dependency findings |

### 6.3 Should verification_evidence have test_layer field? YES, cheap.

```sql
ALTER TABLE verification_evidence ADD COLUMN test_layer TEXT
  CHECK (test_layer IN ('L0','L1','L2','L3','L4'));
```

Payoff is planning, not enforcement. Planner can ask: **"does this AC have evidence at more than one layer?"** — cheap structural version of Verifier-independence.

Two new lint rules:
- **R16** — null test_layer on post-migration rows (warning)
- **R17** — accepted AC with all verified_by evidence at same layer (warning — Verifier likely re-ran Builder's examples)

### 6.4 How does verification.ac know which layer to invoke?

AC document declares it, planner propagates. Extend AC format with test_layer hint per AC, derived from shape:

| AC shape | Recommended layer for verified_by |
|---|---|
| Pure formula/algorithm | L3 (property) — independent of Builder's L2 |
| Schema/format/API | L1 (structural) |
| Behavior with examples | L2 — Verifier chooses own examples |
| Performance/latency | L4 (observation, not evidence) |
| UI/DOM/locale | L2 — different selectors/inputs |
| Security boundary | L1 (SAST) + Authorized Decision (human signoff) |

---

## 7. Independent Verifier problem (CGAD §9)

### 7.1 The current hole, precisely

saga-worker SKILL AC-verification behavior:
1. Read AC
2. **Find corresponding test in code (grep AC-code in tests)** ← HOLE
3. Run it
4. Compare to etalon
5. trace_add(verified_by)

Step 2: test was written by Builder. Verifier re-running Builder's test, NOT producing independent evidence. CGAD §9 explicit: "Builder не может выпускать independent verification evidence для собственной реализации."

cgad-spec-lint R9 catches obvious form (recorded_by == dev task's assigned_to). Does NOT catch subtler: different agent re-running same Builder test. recorded_by values differ, worker_ids differ, R9 passes, "verification" still Builder evidence under Verifier hat.

**This is load-bearing gap.** Everything else (property tests, linter wrappers, registry) is supporting infrastructure for closing this one gap.

### 7.2 What real independence requires

1. **Not read Builder's tests** — imports Builder's assumptions about which inputs matter, edge cases, expected outputs
2. **Generate checks from contract, not code** — contract is AC document (Declared truth)
3. **Produce evidence Builder did not produce** — if Builder wrote L2 examples, Verifier writes L3 property

### 7.3 Contract-as-data: what Verifier needs to generate tests from

Today's ACs are prose. For Verifier to independently generate tests reproducibly, contract needs machine-readable format:

```yaml
ac_code: AC-1
subject: deposit.calculate_compound
inputs:
  - {name: principal, type: float, unit: RUB, range: [0.01, 10000000]}
  - {name: annual_rate, type: float, unit: ratio, range: [0.001, 1.0]}
  - {name: term_months, type: int, range: [1, 360]}
output:
  - {name: final_amount, type: float, unit: RUB, precision: 0.01}
examples:  # L2 etalon
  - {principal: 100000, annual_rate: 0.12, term_months: 12, final_amount: 112682.50}
properties:  # L3 invariants
  - {name: monotonic_in_rate,
     forall: {principal: p, annual_rate: r, term_months: n},
     holds: calculate_compound(p, r+eps, n) >= calculate_compound(p, r, n)}
  - {name: positive_principal_preserved,
     holds: calculate_compound(p, r, n) >= p}
operational:  # L4
  - {metric: p99_latency, threshold: 50ms, scenario: typical_consumer_device}
```

**Missing artifact.** AC document has examples (etalon) and operational (threshold) but no properties block. Structural reason Verifier falls back to re-running Builder's example test: nothing else to run.

Fix at analyst stage: saga-analyst required to produce properties block for algorithmic ACs.

### 7.4 What Verifier skill looks like

1. Read AC + contract-as-data block
2. Read function signature from code (public API; NOT test file)
3. Generate independent checks at different layer from Builder's
4. Run via provider wrappers
5. Record evidence with test_layer populated and provider = actual tool
6. If check fails, return changes_requested with failing property — NOT re-statement of Builder's test

Tools needed: read AC document, read function signature, write to verifier-owned test directory (tests/verifier/AC-1_property_test.py distinct from tests/unit/).

### 7.5 Bootstrap-honesty footnote

CGAD §22-#48 acknowledges bootstrap condition where same agent plays both roles. Saga permanently in this condition for solo-worker projects.

- **Solo-worker:** cannot produce truly independent Verifier evidence by definition. test_layer diversification (L2 Builder + L3 Verifier) is best mitigation — same agent generating L3 from contract rather than re-running L2 from code is structurally producing different evidence. Not independent authority, but independent input.
- **Multi-worker:** truly independent (different agent runs Verifier). R9 + test_layer diversity + verifier-owned directory closes remaining hole.

Claim per Sign 008: "saga has structural independence (different layer, different directory, different generated test) mitigating solo-worker P7 gap; multi-worker mode closes it fully."

---

## 8. Consolidated schema proposals

Three additive migrations, dependency order:

### 8.1 trusted_providers table (§2.4)
Adds one table. provider stays TEXT (FK added later). Lint rules R13, R14.

### 8.2 test_layer on verification_evidence (§6.3)
```sql
ALTER TABLE verification_evidence ADD COLUMN test_layer TEXT
  CHECK (test_layer IN ('L0','L1','L2','L3','L4'));
```
Lint rules R16, R17.

### 8.3 freshness_window_days on trusted_providers (§4.3)
Lint rule R15.

### 8.4 Contract-as-data extension to AC documents (§7.3)
Document format change, enforced by saga-analyst. AC .md gains fenced YAML block. content_hash covers this block.

### 8.5 Verifier-owned test directory convention
Convention enforced by lint. tests/verifier/ = Verifier-authored. R9 strengthened: verified_by evidence citing test NOT under verifier-owned directory flagged.

---

## 9. What changes about planner output

Today:
```
dev-task #N (implements AC-X) → done
verify-task #M (verified_by AC-X, depends_on N, role:reviewer) → done
```

Proposed:
```
dev-task #N
  implements AC-X
  Builder writes L2 example test (etalon)
  evidence: verification_evidence(provider='pytest', layer='L2')

verify-task #M
  verified_by AC-X, depends_on N
  execution_skill: saga-verifier  ← new skill/mode
  test_layer: L3 (from AC's properties block)
  Verifier generates L3 property test from frozen AC contract
  evidence: verification_evidence(provider='hypothesis', layer='L3')

[optional] obs-task #O
  verified_by AC-X (L4 only)
  observe_with_provider: pytest-benchmark
  → runtime_observations row
  → then verify_with_provider: benchmark_threshold
  → verification_evidence(provider='benchmark_threshold', layer='L4')
```

Runtime mechanism unchanged. What changes: planner emits test_layer tag; verifier generates tests from contract-as-data instead of grepping Builder tests; evidence rows carry honest provider and test_layer values.

---

## 10. Open questions for future work

1. **Property tests for stateful systems** — model-based testing (Hypothesis stateful, PropEr parallel). Contract-as-data needs state_machine schema. v2.
2. **Verifier for UI ACs** — property tests don't apply. L2 with independently-chosen inputs. Weaker independence; acknowledge via `independence: 'partial'` flag.
3. **Determinism of LLM-generated property tests** — property from contract but test code from agent. Future hardening: property library keyed by properties.name → pre-written Hypothesis template.
4. **Provider registry bootstrap deadlock** — existing rows need provider:'legacy' registered globally with trust_basis:'pre_registry_unstructured'.
5. **Full Architecture Graph** — ADR-007 keeps descriptive (6 edges vs CGAD's 21). Provider registry and test_layer NOT graph extensions; live in existing tables.
