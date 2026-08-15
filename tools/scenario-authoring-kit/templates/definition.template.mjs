// @ts-check
/**
 * {{SCENARIO_DISPLAY_NAME}} — Lifecycle Scenario definition.
 *
 * Scaffolded by the W10-A6 Scenario Authoring Kit (plan §0.13.10).
 *
 * This is a `LifecycleDefinition`-SHAPED plain object that composes installed
 * module packages across stages. The scenario references module CONTRACTS and
 * installed package IDENTITIES only — never module implementation classes
 * (plan §3.8). That property is what makes the architecture truly extensible:
 * a scenario can be authored and validated WITHOUT touching the Runtime,
 * global runner, gateway, catalog, or any existing module source.
 *
 * CRITICAL design rules baked into this template (plan §6.x):
 *
 * 1. §6.4 — NO `routeResolver` function. Routes are declarative static
 *    `outcomeRoutes` only. The Runtime looks up the target from the static
 *    table; there is no executable closure anywhere in this manifest.
 *
 * 2. §6.8 — A module MAY be reused in multiple stages. The same package can
 *    legitimately participate in several stages with different
 *    input/output mappings. The Runtime must NOT derive a stage from module
 *    kind or task-kind prefix.
 *
 * 3. §6.3.5 / §6.9.3 — Every declared module outcome has exactly one
 *    deterministic static route. Complete route table.
 *
 * 4. §6.3.3 / §6.9.5 — Typed input/output mappings use only safe
 *    own-property paths: root-input paths (`initiative.*`), prior-stage
 *    output paths (`stages.<id>.output.*`), `{ literal: <value> }`, or
 *    `{ runtime: 'initiatedBy' }`. No executable expression language.
 *
 * 5. §6.2.9 — Explicit terminal statuses.
 *
 * Stages:
 *   {{ENTRY_STAGE_ID}} ({{MODULE_NAME_1}})  -> '{{OUTCOME_1}}'
 *      |
 *   {{STAGE_2_ID}} ({{MODULE_NAME_2}})      -> '{{OUTCOME_2_OK}}' | '{{OUTCOME_2_FAIL}}'
 *
 * @typedef {import('../../../../src/process-modules/domain/lifecycle.ts').StageBinding} StageBinding
 */

// ---------------------------------------------------------------------------
// Identity + contracts.
// ---------------------------------------------------------------------------

/**
 * Scenario identity. Mirrors `LifecycleIdentity` from the domain contract.
 */
export const SCENARIO_IDENTITY = Object.freeze({
  name: '{{SCENARIO_NAME}}',
  version: '0.1.0',
  displayName: '{{SCENARIO_DISPLAY_NAME}}',
  description: '{{SCENARIO_DESCRIPTION}}',
});

export const SCENARIO_INPUT_SCHEMA = '{{SCENARIO_NAME}}.input.v1';
export const SCENARIO_OUTPUT_SCHEMA = '{{SCENARIO_NAME}}.output.v1';

/** Terminal statuses declared by this scenario (plan §6.2.9). */
export const TERMINAL_STATUSES = Object.freeze([
  '{{TERMINAL_STATUS_OK}}',
  '{{TERMINAL_STATUS_FAIL}}',
]);

// ---------------------------------------------------------------------------
// Module refs (installed package identities — plan §3.8).
// ---------------------------------------------------------------------------

/** @type {Readonly<{ name: string; version: string }>} */
export const MODULE_REF_1 = Object.freeze({
  name: '{{MODULE_NAME_1}}',
  version: '{{MODULE_VERSION_1}}',
});

/** @type {Readonly<{ name: string; version: string }>} */
export const MODULE_REF_2 = Object.freeze({
  name: '{{MODULE_NAME_2}}',
  version: '{{MODULE_VERSION_2}}',
});

// ---------------------------------------------------------------------------
// Stage bindings (plan §6.2, §6.3).
// ---------------------------------------------------------------------------

/**
 * @type {readonly StageBinding[]}
 */
const stages = [
  {
    id: '{{ENTRY_STAGE_ID}}',
    displayName: '{{ENTRY_STAGE_DISPLAY_NAME}}',
    moduleRef: MODULE_REF_1,
    inputMapping: {
      field1: 'initiative.field1',
    },
    outputMapping: {
      result1: 'output.result1',
    },
    outcomeRoutes: {
      '{{OUTCOME_1}}': { type: 'stage', stageId: '{{STAGE_2_ID}}' },
    },
    entryConditions: ['Scenario root input present'],
    exitConditions: ['{{OUTCOME_1}} outcome emitted'],
  },
  {
    id: '{{STAGE_2_ID}}',
    displayName: '{{STAGE_2_DISPLAY_NAME}}',
    moduleRef: MODULE_REF_2,
    inputMapping: {
      result1: 'stages.{{ENTRY_STAGE_ID}}.output.result1',
    },
    outputMapping: {
      result2: 'output.result2',
    },
    outcomeRoutes: {
      // §6.3.5: complete route table for EVERY declared module outcome.
      approved: { type: 'terminal', status: '{{TERMINAL_STATUS_OK}}' },
      rejected: { type: 'terminal', status: '{{TERMINAL_STATUS_FAIL}}' },
    },
    entryConditions: ['{{ENTRY_STAGE_ID}} stage produced output'],
    exitConditions: ['{{OUTCOME_2_OK}} or {{OUTCOME_2_FAIL}} outcome emitted'],
  },
];

// ---------------------------------------------------------------------------
// The scenario as a plain documented object.
// ---------------------------------------------------------------------------

/**
 * NOTE: There is NO `routeResolver` field anywhere on this object — that
 * omission is the proof of plan §6.4.
 */
export const scenario = Object.freeze({
  manifestFormatVersion: '0.1.0',
  source: 'W10-A6 Scenario Authoring Kit',
  identity: SCENARIO_IDENTITY,
  inputContract: { id: SCENARIO_INPUT_SCHEMA },
  outputContract: { id: SCENARIO_OUTPUT_SCHEMA },
  entryStageId: '{{ENTRY_STAGE_ID}}',
  stages,
  terminalStatuses: TERMINAL_STATUSES,
  // Intentionally absent: routeResolver. Proves §6.4.
});

/**
 * Helper: list module refs used by this scenario. Used to prove the scenario
 * depends only on public module contracts (plan §6.10).
 */
export const scenarioModuleRefs = Object.freeze([MODULE_REF_1, MODULE_REF_2]);

export default scenario;
