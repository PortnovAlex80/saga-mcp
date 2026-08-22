# Workshop Designer V0

Visual authoring surface for Saga Process Modules.

V0 stops deliberately at a **design draft** boundary. It never installs or mutates runtime Process Modules. The UI mirrors the current domain vocabulary: `production-cell`, `kernel`, `human`, transitions, product contracts, gates, reviewer isolation and bounded recovery.

Run from repository root:

```bash
node workshop-designer/server.mjs
```

Open `http://127.0.0.1:4324`.

## V0 capabilities

- visual workshop canvas with movable flow nodes;
- add Production Cell / kernel / human nodes;
- connect nodes with typed events;
- edit Process Module identity and boundary contracts;
- edit Production Cell inputs, product contracts, author, author Gate, optional reviewer/final Gate, recovery and post-acceptance effect;
- mark entry and terminal nodes;
- local browser autosave;
- round-trip JSON import/export;
- design-time conformance report for identities, transitions, cell contracts, reviewer isolation, bounded recovery, reachability, cycles and forbidden node kinds.

The seeded example follows the current Formalization topology: five reviewed Production Cells, deterministic baseline-freeze and settlement nodes, and three terminal outcomes.

## Non-goals

- no catalog installation;
- no TypeScript generation;
- no runtime execution / Run mode;
- no replacement for `assertValidProductionCellDefinition`, install-time validation or workshop conformance packs.

The exported file is explicitly marked `NOT INSTALLABLE`. A future authoritative compiler must translate the draft into a real `ProcessModuleDefinition`, resolve package resources, run production validators and require conformance proof before installation.
