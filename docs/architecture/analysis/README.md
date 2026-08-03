# Architecture Analysis — Index

> Full codebase analysis of saga-mcp (branch saga4), produced from a
> single-context read of the entire project (~890k tokens of source code,
> skills, tests, ADRs, and specs loaded simultaneously).

## Deliverables

| # | Artifact | Document |
|---|---|---|
| 1 | As-Is C4 (Context / Container / Component) | [01-as-is-c4-and-violations.md](01-as-is-c4-and-violations.md) |
| 2 | Architecture Violations & Anti-Pattern Report | [01-as-is-c4-and-violations.md](01-as-is-c4-and-violations.md#14-architecture-violations--anti-pattern-report) |
| 3 | Entry/Exit Points Inventory | [02-data-and-integration.md](02-data-and-integration.md#21-entryexit-points-inventory) |
| 4 | Data Flow Diagrams | [02-data-and-integration.md](02-data-and-integration.md#22-data-flow-diagrams) |
| 5 | Event Catalog | [02-data-and-integration.md](02-data-and-integration.md#23-event-catalog) |
| 6 | Data Storage & Classification Map | [02-data-and-integration.md](02-data-and-integration.md#24-data-storage--classification-map) |
| 7 | Business Rules Catalog | [03-domain-and-rules.md](03-domain-and-rules.md#31-business-rules-catalog) |
| 8 | Domain Glossary (Ubiquitous Language) | [03-domain-and-rules.md](03-domain-and-rules.md#32-domain-glossary-ubiquitous-language) |
| 9 | Functional Requirements (As-Is) | [03-domain-and-rules.md](03-domain-and-rules.md#33-functional-requirements-as-is) |
| 10 | Code Quality & Technical Debt Report | [04-quality-and-risk.md](04-quality-and-risk.md#41-code-quality--technical-debt-report) |
| 11 | Test Coverage Baseline | [04-quality-and-risk.md](04-quality-and-risk.md#42-test-coverage-baseline) |
| 12 | Security As-Is Map | [04-quality-and-risk.md](04-quality-and-risk.md#43-security-as-is-map) |
| 13 | Non-Functional Requirements (As-Is + Gaps) | [04-quality-and-risk.md](04-quality-and-risk.md#44-non-functional-requirements-as-is--stakeholder-gap-list) |
| 14 | Product Vision Hypothesis (UNVERIFIED) | [05-vision-target-gap.md](05-vision-target-gap.md#51-product-vision-hypothesis-unverified--pending-stakeholder-confirmation) |
| 15 | Target Solution Design + ADRs | [05-vision-target-gap.md](05-vision-target-gap.md#52-target-solution-design--adrs) |
| 16 | To-Be C4 | [05-vision-target-gap.md](05-vision-target-gap.md#53-to-be-c4) |
| 17 | Gap Map | [05-vision-target-gap.md](05-vision-target-gap.md#54-gap-map-as-is-vs-to-be) |
| 18 | Characterization Test Plan | [06-execution-plan.md](06-execution-plan.md#61-characterization-test-plan) |
| 19 | Seam Map | [06-execution-plan.md](06-execution-plan.md#62-seam-map) |
| 20 | Risk/Value Prioritization Matrix | [06-execution-plan.md](06-execution-plan.md#63-riskvalue-prioritization-matrix) |
| 21 | Strangler Fig Migration Roadmap | [06-execution-plan.md](06-execution-plan.md#64-strangler-fig-migration-roadmap) |
| 22 | Fitness Functions | [06-execution-plan.md](06-execution-plan.md#65-fitness-functions) |
| 23 | Consolidated Refactoring Execution Plan | [06-execution-plan.md](06-execution-plan.md#66-consolidated-refactoring-execution-plan) |

## Key findings at a glance

- **System identity:** Governance platform for parallel LLM agents; makes invalid actions impossible as valid transitions.
- **Correct patterns (keep):** Pure policy/mechanism split, single-writer invariant, ratchet enforcement, content-addressed products, deny-by-default, data-driven execution.
- **Primary structural risk:** Wave-archaeology comments (~30-40% of key files) + dead v1 paths + saga3/ cross-tree leakage inflate context cost for agents by ~40-50%.
- **Target state:** Self-contained hexagonal modules + slim composition root + clean SPI types.
- **Total estimated refactoring effort:** ~32 hours across 5 phases, all incremental and reversible.
- **Expected outcome:** ~40-50% context-window cost reduction for agents working on any single module.
