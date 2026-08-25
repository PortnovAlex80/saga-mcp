# EK-8 cutover notes — legacy Discovery dispatch / coordinator / intake paths

WP-11D deliverable (plan phase EK-8 workshop conversion): identify the
EXACT legacy files and wiring the WP-12 atomic production cutover deletes
once `src/workflow-kernel/workshops/discovery/**` becomes the production
Discovery authority. The converted package is reachable only from
`tests/workflow-kernel/workshops/discovery/**` until then; nothing in this
list may be deleted before the cutover (they still own the legacy
production path).

## 1. Legacy Discovery module (dispatch/coordinator surface)

- `src/modules/discovery/**` — the whole legacy module:
  - `application/discovery-check-providers.ts` (check wiring replaced by
    the declared CheckPlan providers of the installed workshop manifest +
    the deterministic gate mapping; providers are manifest data, never
    kernel conditionals)
  - `domain/discovery-domain-contracts.ts`,
    `domain/discovery-settlement-records.ts` (sole owner of Discovery
    transitions becomes the Workplace reducer; accepted material is the
    Workplace production revision)
- `src/process-modules/modules/discovery/**` — the legacy Discovery process
  module (flow ownership moves to ProcessRun module flows from the
  installed manifest; R17)

## 2. Legacy intake / decision surfaces

- Legacy kickstart/decision-fork entrypoints that select Discovery work by
  scanning boards/queues instead of the obligation frontier (the
  saga-kickstart flow's dispatcher sections in `src/app/**` and
  `tracker-view/**` that bypass the cognition transport contract)
- Any mutable idea-intake table outside the FactoryRun sole-writer
  repository (idea ingress becomes factoryRun.bootstrap +
  factoryRun.importCapsule over the content-addressed idea bundle)

## 3. What is NOT deleted (explicitly preserved)

- `src/workflow-kernel/**` (all packages; the new authority)
- The opencode shim `tools/agent-proxy/claude-shim.mjs` and the
  FACTORY_CLAUDE_BACKEND_FORBIDDEN enforcement (re-bound behind the real
  cognition transport at cutover, never deleted)
- Legacy Formalization/Development/Delivery/Documentation stage modules
  (their own WPs own their cutover)

## 4. Cutover proof obligations for WP-12 (derived from the WP-11D tests)

- `tests/workflow-kernel/workshops/discovery/structure.test.mjs` pins: no
  production entrypoint outside the kernel imports this package; the
  cognition surface imports no persistence surface; the wait vocabulary is
  the frozen five with only the two declared legitimate kinds.
- After deletion, `npm run build` + all kernel suites + `test:architecture`
  + `test:workflow-complexity` must stay green with the legacy files gone
  (ratchet, no zombie imports, zero workshop-name literals in
  src/workflow-kernel/**).
