# External SEO/Analytics Package

`modules-ext/external-seo/` — an installable **External-node** Process Module
package. This is the Wave 10 (W10-A2) production-grade upgrade of the W0-A7
`tests/fixtures/synthetic-modules/external-seo/` data-only fixture.

Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`

## What it proves

The saga architecture accepts an **arbitrary** External-node package with **no**
Runtime, gateway, catalog, runner, or existing-module source change
(plan §0.13.10). Where the W0-A7 fixture declared an adapter *reference string*
and shipped no implementation, this package ships:

- a real `ProcessModuleManifest`, validated at load by the Wave 1 SPI
  (`validateProcessModuleManifest`);
- a real `NodeProtocolDefinition` per flow node, validated at load by the Wave 1
  SPI (`validateNodeProtocolDefinition`);
- a real `ExternalAdapter` implementation, registered through the Wave 1
  `ExternalAdapterRegistry` and dispatched by the generic
  `ExternalNodeExecutor`;
- real content-addressed JSON Schemas for the input and output contracts;
- real resources (checklist + package description) with computed `sha256Hex`
  digests (no `pending@wave-2` placeholders on resource entries).

## The import list IS the proof

This package imports **only** from the compiled runtime SPI under `dist/`:

| Import | SPI surface |
|---|---|
| `validateProcessModuleManifest` | `dist/process-modules/domain/spi/module-manifest.js` |
| `validateNodeProtocolDefinition` | `dist/process-modules/domain/spi/node-protocol.js` |
| `ExternalAdapterRegistry` (type) | `dist/process-modules/application/external-adapter-registry.js` |
| `sha256Hex` | `dist/shared/canonical-json.js` |

It **never** imports `src/index.ts`, `modules/catalog.ts`, the composition root,
or any built-in module implementation. Adding this package changes zero lines
under `src/` — verified by the `tests/architecture/dependency-direction.test.mjs`
ratchet (the scanner only walks `src/`, and `modules-ext/` lives outside it).

## Layout

```
modules-ext/external-seo/
├── package.json              # installable package descriptor
├── index.mjs                 # single export surface
├── manifest.mjs              # validated ProcessModuleManifest + adapter registration
├── definition.mjs            # pure ProcessModuleDefinition (External node)
├── adapter.mjs               # real ExternalAdapter (deterministic, no network)
├── node-protocols.mjs        # validated NodeProtocolDefinition per flow node
├── manifest.json             # static round-trip rendering (live-validated)
├── schemas/
│   ├── seo-ranking-input.schema.json    # input contract (request shape)
│   └── seo-ranking-output.schema.json   # output contract (ranking snapshot)
└── resources/
    ├── fetch-ranking-checklist.md       # operational checklist
    └── package-description.md           # operator-facing description
```

## Install + dispatch

```js
import { ExternalAdapterRegistry } from '<repo>/dist/process-modules/application/external-adapter-registry.js';
import { ExternalNodeExecutor } from '<repo>/dist/process-modules/application/node-executors/external-node-executor.js';
import { externalSeoPackage } from '<repo>/modules-ext/external-seo/index.mjs';

// 1. Register the shipped adapter under its versioned id.
const registry = new ExternalAdapterRegistry();
externalSeoPackage.registerAdapters(registry);

// 2. Dispatch the fetch-ranking node through the generic executor.
const executor = new ExternalNodeExecutor(registry);
const node = externalSeoPackage.manifest.definition.flow.nodes[0];
const result = await executor.execute({
  projectId: 1, epicId: 1, processRunId: 1,
  module: externalSeoPackage.manifest.definition,
  node,
  input: { keywords: ['red shoes'], searchEngine: 'google', locale: 'us' },
  frame: { runInput: null, productions: {}, receipts: {} },
  heartbeat: () => {},
  initiatedBy: 'operator',
});
// result.runtimeEvent === 'completed'
// result.production.bindings.snapshot.rankings -> [{ keyword, position, url }]
```

## Deterministic stub

The shipped adapter is an in-process deterministic implementation — it produces
a valid ranking snapshot from the request input alone, with no network call. A
production deployment swaps in an HTTP-client-backed adapter registered under the
same versioned id (`seo-ranking-adapter@1.0.0`); the manifest, node protocol,
and flow do not change (plan §4.4.7, §7.2).
