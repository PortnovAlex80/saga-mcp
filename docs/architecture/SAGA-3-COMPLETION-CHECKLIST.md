# Saga 3 — Forbidden shortcuts checklist + completion criteria

Plan §18: Forbidden implementation shortcuts.
Plan §19: Completion criteria.

## §18 Forbidden shortcuts — verified

- [x] Do not dispatch directly from `tasks.status`
  — saga3 dispatches from WorkIntent, not task rows
- [x] Do not treat empty conditions as ready
  — `evaluateReadiness` returns `condition_bindings_empty` (fail-closed)
- [x] Do not preserve a hidden old dispatcher
  — saga3 namespace imports nothing from old orchestrator/dispatcher
- [x] Do not add a temporary mode flag
  — no controller_version, no v2/v3_shadow/v3
- [x] Do not route unknown cases to an older engine
  — no fall_through, no v2 fallback
- [x] Do not create authoritative provenance from worker payload fields
  — `ingestObservation` attaches provenance from controller context (generation, source, env)
- [x] Do not let the controller silently author semantic artifacts
  — controller materializes WorkIntent, worker creates artifacts
- [x] Do not remove a human path without a worker or deterministic replacement
  — human paths (worker_ask_need, pauseAndAlert) simply don't exist in saga3
- [x] Do not call a recovery state change a repair when no worker assignment exists
  — incident authority creates recovery WorkIntent which must be assigned to a worker
- [x] Do not use stage labels as an emergency admission rule
  — admission checks prerequisites, scopes, budget — never stage
- [x] Do not accept tests that sleep on wall-clock time
  — simulator uses VirtualClock, no real sleeps
- [x] Do not mark a mixed-authority scenario as transitional and therefore acceptable
  — no mixed authority exists

## §19 Completion criteria — status

- [x] One entrypoint starts one Saga 3 system
  — `src/saga3/app/engine.ts` `runEngine()`
- [x] One controller owns all authoritative decisions
  — `EpisodeController.stepEpisode()` is the single decision point
- [ ] Every material execution derives from a WorkIntent
  — walking skeleton proves this; full production wiring TBD
- [ ] Every WorkIntent has target conditions and prerequisites
  — pipeline contracts define these; per-AC obligations need expansion
- [x] Every semantic output has a worker and Skill producer
  — skill registry maps all 11 skills to capabilities
- [x] Every output has an ingestion path
  — `ingestWorkerOutput` in `executions/ingestion.ts`
- [x] Every evidence record comes from an authorized observation
  — `ingestObservation` attaches provenance from controller context
- [x] Every missing binding fails closed
  — empty conditions → quiescent, not did_work
- [ ] Every recovery requiring creation creates a worker task
  — IncidentAuthority files incidents; recovery WorkIntent → assignment TBD
- [ ] Every external effect has durable intent and observation
  — EffectIntent type exists; durable persistence TBD
- [x] Every terminal episode has an immutable truthful certificate
  — `issueCertificate` in `domain/outcomes.ts`
- [ ] No old process, runtime mode, compatibility flag, or fall-through authority remains
  — old code still in src/ (disposition documented, deletion after full verification)

## §17 CI scopes

### Pull request scope
- build and typecheck: `npm run build`
- saga3 unit tests: `node --test tests/saga3/`
- resource and lease leak detection: simulator asserts no leaks

### Nightly scope (when implemented)
- complete generated state-machine exploration
- broad deterministic interleavings
- full crash matrix
- real process kill/restart
- real Git integration conflicts
- mutation tests for authority boundaries

### Release scope (when implemented)
- every productive transition
- every causal-readiness case
- every terminal truth-table case
- full end-to-end obligations
- real adapters in controlled environments
- no forbidden legacy imports or mode flags
