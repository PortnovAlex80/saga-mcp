# SRS — Software Requirements Specification

## §1 Introduction

This SRS covers the deterministic test harness factory.

## §D Decomposition

### §D2 Acceptance Criteria Decomposition

```yaml
- ac: AC-1
  title: Pipeline Completes
  module: tests/mock-claude/button.mjs
  files:
    - tests/mock-claude/button.mjs
  invariants:
    - "Factory reaches terminal status"
  test_layers:
    - e2e
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker
- ac: AC-2
  title: NFR Compliance
  module: tests/mock-claude/scripted-executor.mjs
  files:
    - tests/mock-claude/scripted-executor.mjs
  invariants:
    - "Scripted workers substitute LLM"
  test_layers:
    - contract
  pattern: B
  depends_on: []
  ac_kind: implementation
  criticality: degradable
```

## §12 Decision Log

| # | Decision | Source/profile | Alternatives considered | Rationale | Date |
|---|----------|---------------|------------------------|-----------|------|
| 1 | Use scripted workers | CONVEYOR v4.3 §16 | Real LLM, fixture replay | Deterministic, fast, contract-faithful | 2026-08-08 |
