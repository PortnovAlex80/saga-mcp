# Critic 2: Empirical Skeptic (Context Rot)

> **Source:** research agent run 2026-07-17, subagent `agent_d1d19ff3`.
> **Stance:** Empirical skeptic. Bible: AGENTS.md can reduce agent task success by 20%+ (Raschka/ETH). "Wrong context is worse than less context."
> **Verdict:** "Well-argued synthesis of real tension, but load-bearing novel claim has zero empirical support and is contradicted in closest analogs. Currently an opinion with TRIZ wrapper, not research result."

---

## Seven critiques with falsification tests

### 1. Face/Body desynchronization is unsolved; stale Faces are net-negative

**Empirical claim:** Face that drifts from Body is worse than no Face.

**Evidence:** F10 (Raschka AGENTS.md, Eberhardt, ETH) — adding context files can reduce agent task success by 20%+. Extra context dilutes signal, increases lost-in-middle, misdirects if stale.

Charter acknowledges drift as failure mode (§7 cites accepted_hash + drift_state for stale specs). But drift machinery for **Faces is absent.** R19 ("Body export/import matches Face") punted as "requires AST analysis, future." Even at full strength R19 checks only *structural* alignment. **Cannot catch semantic drift:** Body returns User, Face declares UserDTO; Body takes principal: float, Face declares principal: Decimal.

Proposal silent. "Lint it" is only mechanism — lint provably cannot do the job. Needs either (a) generative test confirming Body satisfies Face invariants (then Face is just L3 property test), or (b) acceptance that stale Faces mislead agents (F10 penalty applies).

**Falsification test:** Inject 10 Face/Body semantic drifts. Run 30 agent tasks on drifted vs 30 on non-drifted control. If success rates indistinguishable → Faces decorative. If drifted underperforms both control AND no-Face baseline → Faces actively harmful when stale (normal state of hand-maintained artifact).

### 2. "Large cohesive Body" directly contradicts context rot literature

**Empirical claim:** 2000-line Body is not cohesive context unit; it is context-rot generator.

**Evidence:** Charter §3 "Large acceptable (1000-3000 lines OK)." F11 (Liu et al. "Lost in the Middle" TACL 2024): LLMs U-shaped recall, worst in middle. Chroma context-rot report + arXiv 2506.20081 corroborate.

Charter's own cited source (F2 Anthropic context engineering): "Warns against dumping whole files: retrieve relevant slice." Constellation's defining instruction — "load one Body, work entirely inside it" — is exact anti-pattern Anthropic names. Report 05 summary verdict retreats to "NOT 'large files' but 'small cohesive files + Face/Body + progressive disclosure'" — but charter §3 still authorizes 3000-line Bodies. **Two documents disagree.**

**Falsification test:** Same module, 3 representations: (a) one 2000-line Body, (b) four 500-line files with imports, (c) 2000-line Body + Aider token-budgeted repo map. Measure success on modifications targeting middle of Body. Per F11, predict (a) underperforms both (b) and (c) on middle-located edits.

### 3. Declared Faces not empirically validated against computed repo maps

**Empirical claim:** Every codebase-graph approach that demonstrably improves performance is *computed*, not declared.

**Evidence:** F6 (Aider) tree-sitter→PageRank→token budget. F8 (Sourcegraph SCIP) precomputed in CI. F7 (Cursor) chunked, hashed, embedded. Report 05 T3: "Navigation tooling compensates for codebase structure rather than demanding better structure... None argues 'write codebase *as* graph.'"

Charter calls gap an opportunity (§3, G2). **Equally an indictment:** no one has shown authored graphs outperform computed ones. Industry voted with its code.

Closest declared-Face analog (F3 Anthropic Skills): Face = 5-15 lines metadata, not 50-200 lines of ports/invariants/conflict-keys. Skill pattern works because Face is *minimal and stable*. Charter's Face is maximal and drift-prone — **opposite design point.**

**Falsification test:** Aider exists. Run N agent tasks under (a) Aider computed repo map, (b) hand-authored Faces in charter format. Measure task success, time, token cost. If (b) doesn't beat (a) with statistical significance, central novel contribution (G1, G2) has no empirical basis.

### 4. Independent Verifier hole is amplified, not closed, by Faces

**Empirical claim:** Shared Face gives Builder and Verifier *common* wrong reference, structurally guaranteeing they fail together.

**Evidence:** Report 04 §7.1 explicit: today's Verifier "greps for Builder-written test tagged with AC code and re-runs it." Charter doesn't address §7.1 — "Verifier" appears only in H3/H4 context.

Worse: shared Face becomes shared erroneous oracle. Current state — Builder reads prose SRS, Verifier reads prose SRS — at least has variance that each may extract different understandings. Machine-readable Face removes that variance, along with chance of independent error discovery.

**Falsification test:** 20 ACs, each with deliberate latent bug in contract. Run Builder+Verifier against (a) prose SRS, (b) declared Face. Count cases where Verifier catches bug. If (b) catches fewer than (a), Faces reduced verifier independence by collapsing two interpretations into one shared error.

### 5. TRIZ framing is rhetorical; "physical contradiction" is false dichotomy

**Empirical claim:** Contradiction is not physical — file size not physical parameter, resolution is re-statement of existing small-file-plus-repo-map approach.

**Evidence:** TRIZ "physical contradictions" apply to parameters genuinely unable to both increase and decrease. File size has no such constraint: 300-line file with 50-line Face is just two small files. Resolution structurally identical to: small files + Aider repo map + saga trace table.

F6 (Aider), F8 (Sourcegraph), F7 (Cursor) already provide "discovery surface." F14 already establishes "small file" consensus. TRIZ table maps 7 principles but mapping is post-hoc: #17 satisfied by any metadata layer; #25 by any queryable graph. **TRIZ doing no work beyond lending gravitas.**

If resolution is "small files + good repo map" = Aider/Cursor, not new architecture. If "declared Faces" = needs evidence, not TRIZ frame.

**Falsification test:** Define operationally what Constellation provides that "small files + computed repo map + saga trace table" doesn't. If only answer "Faces hand-authored and declared" → proposal reduces to "authored > computed" = critique 3's test.

### 6. 12-datapoint table is post-hoc rationalization, not evidence

**Empirical claim:** Charter §7 lists features shipped for stated LLM constraints. None designed to test Constellation. Treating as supporting evidence is confirmation bias.

**Evidence:** Table attributes each feature to narrow LLM constraint (completeness-gate → session memory; 4-valued verdict → confidence calibration; RiskClass max() → risk self-lowering). **None has anything to do with Face/Body separation, declared graphs, dimensional asymmetry.** Being retconned. Several predate Constellation entirely. **Texas sharpshooter fallacy.**

H1-H6 unfalsifiable in current form. H1 ("fewer conflicts") — at what N? What statistical power? Which SRP baseline? H5 ("reduces lost-in-codebase incidents") — how is incident counted? Charter §6 outlines methodology but no sample size, blinding, experimenter bias.

**Falsification test:** Pre-register H1 with sample size: Cohen's d=0.5, α=0.05, power=0.8 → N≈64 per arm. Single planned Exp-1 (water-cannon) is N=1. Until N reaches significance, "supporting evidence" wrong phrase.

### 7. OQ3 is not "open question" — it is THE design decision

**Empirical claim:** Charter cannot run single valid experiment until OQ3 resolved, because answer determines whether Faces are machine-queryable contracts or prose-with-anchors.

**Evidence:** §4.4 R20 requires machine-readable Faces. §4.2 trace link types (exports, consumes, protects) require structured Faces. H5 cannot be measured without Face format. **Everything load-bearing suspended on one decision listed as minor implementation detail.**

Risk: YAML Faces reintroduce IDL/WSDL (which §3 disclaims) with new name; markdown Faces unverifiable by any rule beyond R18 (presence check). Neither defended.

**Falsification test:** Implement 5 Faces in YAML, 5 in markdown. Run R18-R21. Report which rules actually fire. If most fire only against YAML and YAML looks indistinguishable from OpenAPI specs, "this is not just IDL" defense collapses.

---

## What would convince me

Three concrete results would move skeptic → agnostic; plus replication → proponent:

1. **Declared-Face beats computed-repo-map, double-blinded.** 30 modules, same agent, same tasks; treatment = hand-authored Faces, control = Aider repo map. Treatment wins on success and median time at p<0.05.

2. **Drift survival curve.** Inject semantic Face/Body drift at known rates (0%, 10%, 30%). Plot success vs drift rate. If flat or gracefully degrading → robust. If cliffs at low drift → must ship real drift detector (not R19) before production.

3. **Middle-of-Body recall test on code tasks.** Target modifications at lines 100, 1000, 1900 of 2000-line Body. If performance flat → F11 doesn't transfer to code authoring, large Body survives. If U-shapes → reduce 3000-line ceiling or integrate slice retrieval (back to Aider).

---

**Bottom line:** Report 05's own G5 — "No peer-reviewed study of Face/Body, scaffolding-then-parallel, or artifact-graph imports" — is honest summary. Constellation Architecture is currently opinion with TRIZ wrapper, not research result. Fix: run three experiments before building schema changes on unvalidated foundation.
