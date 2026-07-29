# Module Authoring Kit (W10-A5)

> Wave 10, Lane A5. Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
> Task: `docs/refactor-management/05-subagent-tasks/W10-a5.md`.

A developer-facing kit that lets you **scaffold** a new Process Module package,
**validate** it, and **test conformance** against the canonical contract — with
zero edits to `src/` and zero coupling to the Runtime.

This kit is the Wave 10 extensibility proof point for module authoring: a
manifest that passes here is accepted by the Wave 2 content-addressed installer,
because the kit **imports the canonical validators** from the built `dist/`
tree rather than re-implementing them. The kit and the installer never drift.

## Layout

```
tools/module-authoring-kit/
├── validator.mjs              # Library + CLI (scaffold | validate | conform | conform-corpus)
├── validator.test.mjs         # Validator unit tests (golden + each error code)
├── scaffold.test.mjs          # Scaffold round-trip tests (every node kind)
├── conform.test.mjs           # Conformance corpus regression test
├── package.json               # Kit metadata + bin entry
├── templates/                 # Package skeletons, one per node kind
│   ├── lm-node/               # Language Model authoring node
│   ├── kernel-node/           # Deterministic kernel handler node
│   ├── external-node/         # External adapter node
│   └── human-node/            # Human approval node (two terminal outcomes)
└── fixtures/                  # Contract test corpus
    ├── index.json             # Corpus manifest (valid + negative cases)
    ├── valid-golden/          # A canonical manifest that passes validation
    └── negative/              # One JSON per isolated validation failure
```

## Prerequisites

The kit imports the canonical validators from `dist/`, so build the repo first:

```sh
npm run build
```

## Quick start

### 1. Scaffold a package

```sh
node tools/module-authoring-kit/validator.mjs scaffold lm-node modules-ext/my-marketing \
  --vars MODULE_NAME=my-marketing MODULE_VERSION=0.1.0 \
         MODULE_KIND=marketing MODULE_DISPLAY_NAME="My Marketing" \
         MODULE_DESCRIPTION="Self-contained LM Marketing module."
```

This copies `templates/lm-node/` into `modules-ext/my-marketing/` and substitutes
every `{{VAR}}` placeholder. Required vars: `MODULE_NAME`, `MODULE_VERSION`.
Recommended: `MODULE_KIND`, `MODULE_DISPLAY_NAME`, `MODULE_DESCRIPTION` (each
defaults to `MODULE_NAME` / a generated string when omitted).

### 2. Validate the manifest

```sh
node tools/module-authoring-kit/validator.mjs validate modules-ext/my-marketing/manifest.json
```

Runs the SAME two validators the installer runs:

1. **Canonical manifest validator** (W1-A2 `validateProcessModuleManifest`) —
   structural completeness + canonical serializability. Emits typed errors with
   stable codes (`MANIFEST_*`, `RESOURCE_*`, `HANDLER_*`).
2. **Application-layer definition validator** (`validateProcessModuleDefinition`)
   — identifier format, semver, flow reachability, terminal-node/outcome
   emission, execution-profile references.

### 3. Run full conformance (validate + resources exist)

```sh
node tools/module-authoring-kit/validator.mjs conform modules-ext/my-marketing/manifest.json
```

Like `validate`, plus checks that every `resourceIndex[].path` resolves under
the package root on disk.

### 4. Run the contract corpus

```sh
node tools/module-authoring-kit/validator.mjs conform-corpus
```

Runs every fixture in `fixtures/index.json`: each valid case must pass, each
negative case must fail with its declared `expectedErrorCodes`. Exit 0 iff all
pass.

## Node-kind templates

| Template | Node kind | Terminal outcomes | Pattern |
|---|---|---|---|
| `lm-node` | `lm` | one | Single LM author node with an execution profile (semantic skill, tracker, retry/recovery policy). |
| `kernel-node` | `kernel` | one | Single deterministic kernel node with a versioned `handler` ref + a `test`-enforced deterministic invariant. |
| `external-node` | `external` | one | Single external adapter node with a versioned `adapter` ref. |
| `human-node` | `human` | two (`approved`/`rejected`) | A non-terminal human node routes via transitions to per-outcome terminal kernel emitter nodes — the canonical pattern for a complete route table (mirrors `delivery` `approve-release`). |

## The Human-node pattern

A Human node that needs two terminal outcomes (approve/reject) cannot itself be
terminal — the contract requires every terminal node to emit exactly one
outcome. The `human-node` template models the canonical pattern (also used by
the production Delivery module): the human node pauses for a decision, then
routes via `transitions` to one terminal kernel `process-outcome-emitter` node
per outcome:

```
approve (human) --domain.approved--> emit-approved (kernel, terminal, emits "approved")
               \--domain.rejected-> emit-rejected (kernel, terminal, emits "rejected")
```

## The contract corpus

`fixtures/negative/` contains one JSON file per isolated canonical-validation
failure mode. Each declares the `expectedErrorCodes` it must surface. Add a new
case by dropping a JSON file in `negative/` and listing it in
`fixtures/index.json`. The corpus is the regression ratchet: if the canonical
validator gains a new check, add a matching negative fixture.

| Fixture | Expected code |
|---|---|
| `missing-manifest-format-version.json` | `MANIFEST_FORMAT_VERSION_EMPTY` |
| `definition-missing.json` | `MANIFEST_DEFINITION_MISSING` |
| `definition-field-array.json` | `MANIFEST_DEFINITION_FIELD_INVALID` |
| `resource-kind-unknown.json` | `RESOURCE_KIND_UNKNOWN` |
| `resource-logical-id-duplicate.json` | `RESOURCE_LOGICAL_ID_DUPLICATE` |
| `handler-refs-duplicate.json` | `HANDLER_LOGICAL_ID_DUPLICATE` |
| `contract-ref-invalid.json` | `MANIFEST_CONTRACT_REF_INVALID` |
| `compat-range-invalid.json` | `MANIFEST_COMPAT_RANGE_INVALID` |

## Tests

```sh
npm run build
node --test tools/module-authoring-kit/validator.test.mjs \
             tools/module-authoring-kit/scaffold.test.mjs \
             tools/module-authoring-kit/conform.test.mjs
```

## Anti-scope (WAVE10-EXTENSIBILITY-SPEC §3)

This kit touches NOTHING under `src/`. It is plain Node ESM under `tools/`, so
it does not participate in `tsc` and is invisible to the dependency-direction
ratchet (which scans only `src/`). The validators are imported from the built
`dist/` tree — that is the single, deliberate coupling point, and it guarantees
kit/installer agreement by construction.
