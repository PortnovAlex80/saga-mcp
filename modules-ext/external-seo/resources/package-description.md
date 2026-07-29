# External SEO/Analytics Package

`modules-ext/external-seo/` — an installable External-node Process Module
package. This is the Wave 10 production-grade upgrade of the W0-A7
`tests/fixtures/synthetic-modules/external-seo/` data-only fixture.

## What it proves

The architecture accepts an ARBITRARY External-node package with no Runtime,
gateway, catalog, or existing-module source change (plan §0.13.10). The package
ships:

- a real `ProcessModuleManifest` validated by the Wave 1 SPI;
- a real `NodeProtocolDefinition` per flow node, validated by the Wave 1 SPI;
- a real `ExternalAdapter` implementation registered through the Wave 1
  `ExternalAdapterRegistry` (deterministic — no network);
- real content-addressed JSON Schemas for input and output contracts;
- real resources (checklist + this description) with computed digests.

## Boundary

This package imports ONLY from the compiled runtime SPI
(`dist/process-modules/...`): the manifest validator, the node-protocol
validator, the canonical-json hasher, and the external-adapter registry. It
NEVER imports `src/index.ts`, the built-in module catalog, or any production
module implementation. That import list IS the §0.13.10 proof.

## Install

```js
import { externalSeoPackage } from './modules-ext/external-seo/index.mjs';
// externalSeoPackage.manifest        — validated ProcessModuleManifest
// externalSeoPackage.nodeProtocols   — validated NodeProtocolDefinition[]
// externalSeoPackage.adapters        — Record<adapterId, ExternalAdapter>
// externalSeoPackage.register(registry) — registers adapters on a registry
```
