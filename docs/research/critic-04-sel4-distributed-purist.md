# Critic 4: Distributed Systems / seL4 Purist

> **Verdict:** Analogies are inspirational, not formal. Proposal strongest when presenting authoring disciplines for LLM navigability; weakest when borrowing formal-verification vocabulary of seL4/E/WASM.

## Six critiques

1. **seL4 analogy conflates invocation-time authority with design-time declaration.** CSpace mediates every kernel operation; saga DB is registry of declarations Python never consults at runtime. Category error that becomes dangerous when documentation treated as guarantee.

2. **Actor isolation is runtime property; "no imports" at authoring time doesn't produce it.** BEAM enforces per-process heaps. Python `import body_b; body_b.private = 0` is legal, Face-transparent. No BEAM equivalent in target languages.

3. **WIT is structural because of Canonical ABI, which proposal lacks.** WIT specifies lifting/lowering, linear-memory isolation, trap containment. Without runtime ABI mediator, "WIT for Face" is exactly WSDL/IDL.

4. **Capability semantics require unforgeable references.** Python/JS/TS don't provide them. `importlib.import_module("anything")` is ambient authority Face can't gate.

5. **"saga DB as kernel" inherits dual-write problem kernel doesn't have.** Face/Body committed separately (different files, different DB rows, different times). Face-level concurrency: Face edits become new merge bottleneck.

6. **Event sourcing requires typed versioned deterministic event model — observation_record provides none.** Free-form strings unreplayable. No deterministic handlers, no idempotency, no snapshot strategy, no schema evolution.

## Where analogies DO hold

1. **Capability-gated routing for discovery** — sound as discovery-time analog, not enforcement claim
2. **WIT as Face declaration format** — genuinely better than ad-hoc signatures for navigability
3. **Actor discipline as authoring heuristic** — five meta-patterns are Actor-descended design vocabulary, legitimate if humbler claim
