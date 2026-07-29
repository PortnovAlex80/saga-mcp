/**
 * W10-A3 — Human Director Approval module definition.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`
 *       (lane W10-A3: arbitrary Human-node extensibility proof).
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a3.md`.
 * Plan: §0.13.10 (Wave 10 serial gate), §0.3.8, §14.1.4, §15.11.
 *
 * This file owns the `ProcessModuleDefinition` for the Human Director Approval
 * Process Module — a self-contained, installable Human-node package that lives
 * OUTSIDE the compiled `src/` tree. It is the production upgrade of the W0-A7
 * `tests/fixtures/synthetic-modules/human-director-approval/` data-only fixture:
 * the same Human-node shape (one `human` node with an `interactionContract`, two
 * terminal outcomes `approved` / `rejected`), now packaged as a real installable
 * module with a validated manifest, a real NodeProtocol, pinned resources, and
 * versioned contract refs (see `manifest.ts`).
 *
 * Purity (plan §3.5): this module is PURE DATA. It imports only the SPI
 * `ProcessModuleDefinition` / `FlowDefinition` TYPES (erased at runtime) — no
 * validators, no behavior, no persistence, no infrastructure. The definition is
 * a plain readonly object the manifest (`manifest.ts`) wraps and the installer
 * persists verbatim.
 *
 * Import-boundary proof (WAVE10-EXTENSIBILITY-SPEC §4): this file imports ONLY
 * the pure domain SPI types from `src/process-modules/domain/process-module.ts`
 * (via the compiled `dist/` declaration emitted by the root build). It NEVER
 * imports `src/index.ts`, `modules/catalog.ts`, the composition root, or any
 * existing module implementation. That import list IS the §0.13.10 proof.
 *
 * Anti-scope: NO edits to `src/`. This entire package lives under
 * `modules-ext/` at the repository root, outside the root `tsconfig.json`
 * include glob (the `src` subtree), so the root `npm run build` compiles it
 * with ZERO diff to `src/` — exactly the Wave 10 exit-gate proof.
 */

import type {
  FlowDefinition,
  ProcessModuleDefinition,
} from '../../../dist/process-modules/domain/process-module.js';

// ---------------------------------------------------------------------------
// Module identity.
// ---------------------------------------------------------------------------

/**
 * The canonical `name@version` identity of this module. Mirrors the fixture's
 * `HUMAN_DIRECTOR_APPROVAL_MODULE_REF` but drops the `synthetic-` prefix: this
 * is a real, installable package, not a data-only fixture.
 */
export const HUMAN_DIRECTOR_APPROVAL_MODULE_REF = Object.freeze({
  name: 'human-director-approval',
  version: '1.0.0',
});

/**
 * Runtime API compatibility range this package requires. The Human-node SPI is
 * stable across the saga 3.x process-module runtime; the `<4.0.0` upper bound
 * reserves room for the 4.x cutover (matches the production modules).
 */
export const HUMAN_DIRECTOR_APPROVAL_RUNTIME_COMPATIBILITY_RANGE = '^3.0.0';

// ---------------------------------------------------------------------------
// Schema ids (input / output / interaction contract).
//
// These ids match the `inputContract.id` / `outputContract.id` on the
// definition below and the `$id` of the JSON Schemas shipped under `schemas/`.
// The Wave 2 ContractSchemaRegistry will register concrete codecs behind each
// id; until then the manifest carries the ids with the documented placeholder
// digest (`CONTRACT_REF_PENDING_DIGEST`).
// ---------------------------------------------------------------------------

/** Input contract: a scored campaign bundle awaiting a director decision. */
export const HUMAN_DIRECTOR_INPUT_SCHEMA = 'saga3.human-director-approval.input.v1';

/** Output contract: the director's signed decision envelope. */
export const HUMAN_DIRECTOR_OUTPUT_SCHEMA = 'saga3.human-director-approval.output.v1';

/**
 * Interaction contract the Human node pauses on (plan §4.4.6 / §7.2). The
 * human-interaction registry (Wave 2) binds a concrete decision provider behind
 * this id; the manifest declares only the identity.
 */
export const HUMAN_DIRECTOR_INTERACTION_CONTRACT =
  'saga3.human-director.signoff.v1';

/**
 * Exact versioned adapter reference (plan §5.5.10). The director-console
 * adapter owns the durable request/decision store. Wave 2 binds this to the
 * human-interaction registry; the manifest carries only the reference string.
 */
export const DIRECTOR_CONSOLE_ADAPTER_REF = 'director-console-adapter@1.0.0';

// ---------------------------------------------------------------------------
// Flow.
//
// One Human node (`director-signoff`) with an `interactionContract`. The node
// is terminal: it emits one of two outcomes (`approved` / `rejected`) which the
// campaign scenario routes deterministically to two different terminal
// statuses (plan §6.3.5: complete route table for every declared outcome).
// ---------------------------------------------------------------------------

/**
 * The single Human flow node this module owns. Carries an `interactionContract`
 * (the Human-node-specific field — see `HumanFlowNodeDefinition`).
 */
const directorSignoffNode = {
  id: 'director-signoff',
  label: 'Director Sign-off',
  kind: 'human' as const,
  description:
    'Pause for a director sign-off decision (approve / reject) on the scored ' +
    'campaign. The director-console adapter owns the durable request/decision ' +
    'store; the runtime pauses until a decision is recorded.',
  interactionContract: { id: HUMAN_DIRECTOR_INTERACTION_CONTRACT },
  inputSchema: { id: HUMAN_DIRECTOR_INPUT_SCHEMA },
  outputSchema: { id: HUMAN_DIRECTOR_OUTPUT_SCHEMA },
};

/**
 * The single-flow definition. One node, no inter-node transitions (the node is
 * terminal), one terminal node id.
 */
const humanDirectorFlow: FlowDefinition = {
  id: 'human-director-approval.standard',
  version: '1.0.0',
  entryNodeId: 'director-signoff',
  nodes: [directorSignoffNode],
  transitions: [],
  terminalNodeIds: ['director-signoff'],
};

// ---------------------------------------------------------------------------
// ProcessModuleDefinition.
//
// Two terminal outcomes so the campaign scenario (W10-A4) can prove a complete
// deterministic route table for EVERY declared outcome (plan §6.3.5 / §6.9.3):
// `approved` -> campaign-approved, `rejected` -> campaign-rejected.
// ---------------------------------------------------------------------------

/**
 * The full, pure-data Human Director Approval module definition. The manifest
 * (`manifest.ts`) wraps this in a `ProcessModuleManifest` and validates it.
 *
 * Human modules carry NO LM execution profiles (the Human node pauses for an
 * external decision; there is no semantic skill the runtime drives). The empty
 * `executionProfiles` array is correct and load-bearing — it proves the SPI is
 * module-kind-agnostic (plan §3.6, §7.2).
 */
export const humanDirectorApprovalModule: ProcessModuleDefinition = {
  identity: {
    ...HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
    kind: 'human-approval',
    displayName: 'Human Director Approval',
    description:
      'Installable Human-node module: pauses for a director sign-off decision ' +
      '(approve / reject) on a scored campaign. Proves arbitrary Human-node ' +
      'extensibility (WAVE10-EXTENSIBILITY-SPEC §1 lane W10-A3).',
  },
  inputContract: { id: HUMAN_DIRECTOR_INPUT_SCHEMA },
  outputContract: { id: HUMAN_DIRECTOR_OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'approved',
      description: 'The director approved the campaign.',
      terminal: true,
    },
    {
      code: 'rejected',
      description: 'The director rejected the campaign.',
      terminal: true,
    },
  ],
  flow: humanDirectorFlow,
  artifacts: [
    {
      type: 'director-decision',
      schema: { id: HUMAN_DIRECTOR_OUTPUT_SCHEMA },
      authority: 'human',
      description:
        'Opaque director decision envelope produced by the Human node. The ' +
        'director-console adapter owns the durable decision store; the runtime ' +
        'records the envelope as the node-run production.',
    },
  ],
  policies: [],
  invariants: [],
  executionProfiles: [],
};
