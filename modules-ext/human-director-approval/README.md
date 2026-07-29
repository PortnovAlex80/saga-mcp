# @saga-ext/human-director-approval

> **W10-A3** — Installable Human-node Process Module for the saga process-module
> runtime. Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.

This is the production upgrade of the W0-A7
`tests/fixtures/synthetic-modules/human-director-approval/` data-only fixture
into a **full installable Human module**. It proves arbitrary **Human-node**
extensibility: the package installs and executes through the saga process-module
SPI **without any Runtime, global runner, gateway, catalog, or existing-module
source change** (WAVE10-EXTENSIBILITY-SPEC §0.13.10).

## What it is

A `human-approval` Process Module with one Human node (`director-signoff`) that
pauses for a director sign-off decision on a scored campaign bundle. It declares
**two** terminal outcomes — `approved` and `rejected` — so the Campaign scenario
(W10-A4) can route deterministically to two different terminal statuses
(`campaign-approved`, `campaign-rejected`), proving a complete route table for
every declared module outcome (plan §6.3.5).

## Package contents

```
modules-ext/human-director-approval/
├── package.json                              installable npm package
├── tsconfig.json                             type-checks the package against the SPI
├── README.md                                 this file
├── src/
│   ├── index.ts                              public export surface
│   ├── definition.ts                         ProcessModuleDefinition (Human node, 2 outcomes)
│   ├── manifest.ts                           validated ProcessModuleManifest
│   └── node-protocols/
│       └── director-signoff-node-protocol.ts validated NodeProtocolDefinition
├── schemas/
│   ├── director-signoff.schema.json          interaction contract ($id saga3.human-director.signoff.v1)
│   ├── director-signoff-input.schema.json    input contract
│   └── director-signoff-output.schema.json   output contract
├── resources/
│   ├── director-signoff-instruction.md       pinned by NodeProtocol step present-scoring
│   └── director-signoff-checklist.md         pinned by NodeProtocol step present-scoring
└── test/
    └── human-director-approval.test.mjs      package test (manifest + NodeProtocol + resources)
```

## Identity

- **Module:** `human-director-approval@1.0.0`
- **Kind:** `human-approval`
- **Manifest format version:** `'1'`
- **Runtime compatibility:** `^3.0.0`
- **Interaction contract:** `saga3.human-director.signoff.v1`
- **Adapter:** `director-console-adapter@1.0.0`

## Import boundary (the §0.13.10 proof)

This package imports ONLY from the pure process-module SPI:

- `domain/spi/module-manifest.js` — `ProcessModuleManifest`, `HandlerRef`,
  `ResourceIndexEntry`, `validateProcessModuleManifest`, `PENDING_DIGEST`.
- `domain/spi/node-protocol.js` — `NodeProtocolDefinition`,
  `EvidenceRequirement`, `validateNodeProtocolDefinition`.
- `domain/spi/resource-index.js` — `ResourceIndexEntry`.
- `domain/spi/contract-ref.js` — `ContractRef`,
  `CONTRACT_REF_PENDING_DIGEST`.
- `domain/process-module.js` — `ProcessModuleDefinition`, `FlowDefinition`
  (type-only).

It NEVER imports `src/index.ts`, `modules/catalog.ts`, the composition root,
`tracker-view/`, or any existing module. That import list **is** the
extensibility proof: the runtime accepted an arbitrary Human-node package
through its public SPI alone.

## Anti-scope

This package lives under `modules-ext/` at the repository root, OUTSIDE
`tsconfig.json`'s `include: ["src/**/*"]`. The root `npm run build` (`tsc`)
therefore compiles with **zero diff to `src/`** while this package exists —
exactly the Wave 10 exit-gate proof that the architecture is truly extensible.

## Run the package test

```sh
# from the repository root (after `npm run build` emits dist/):
node --test modules-ext/human-director-approval/test/human-director-approval.test.mjs
```

The test loads the TypeScript source directly (Node ≥ 22.6 type-stripping),
validates the manifest and NodeProtocol through the SPI validators compiled into
`dist/`, asserts every pinned resource resolves under the package root, and
re-asserts the import boundary above.
