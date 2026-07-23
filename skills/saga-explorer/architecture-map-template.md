# Architecture Map Template — saga-explorer

This is the **output template** the explorer fills in to ground its hypothesis
experiment. It is a *scoped* map — not a whole-repo onboarding guide — covering
the modules, dependencies, and entry points surrounding the hypothesis's
`touches_files`. The explorer writes it into `result-N.json` under the
`architecture_map` field (see SKILL.md §"Output spec").

The structure borrows the architecture-map sections from EXT-2 (codebase-
onboarding) and the reverse-engineering output discipline from EXT-12
(codebase-exploration), reconciled to CGAD terminology. Borrowed material is
marked with `<!-- source: EXT-N ... -->`.

> **Scope note.** The explorer is Phase 3 of the T-011 adaptive-retry protocol.
> It does NOT onboard a whole unfamiliar codebase. It maps *just enough*
> architecture around the touched surface to (a) apply the hypothesis faithfully
> and (b) record which modules the change ripples into. Keep the map bounded —
> if you are mapping more than ~6 modules, the hypothesis has scope drift; record
> `verdict: 'fails'` per the anti-patterns in SKILL.md.

---

## Filled-in map (template)

```json
{
  "architecture_map": {
    "overview": {
      "product": "<product name from .saga/project.json>",
      "repository": "<repository name>",
      "map_scope": "<one sentence: which slice of the codebase this map covers, anchored on touches_files>",
      "map_purpose": "Why this map exists — e.g. 'to confirm H2's dynamic-import split does not break the existing render entry point'"
    },

    "module_map": [
      <!-- source: EXT-2 https://github.com/affaan-m/everything-claude-code/blob/main/skills/codebase-onboarding/SKILL.md
         (onboarding "Directory Map" / module-list section, scoped to touched surface) -->
      {
        "module": "<file or directory path relative to repo root>",
        "responsibility": "<one sentence: what this module does>",
        "touched_by_hypothesis": true,
        "role_in_experiment": "target | dependency-of-target | entry-point | sibling-affected"
      }
    ],

    "dependency_graph": {
      <!-- source: EXT-2 (onboarding "Architecture" dependency-edges section) -->
      "edges": [
        { "from": "<module>", "to": "<module>", "kind": "imports | calls | implements | extends" }
      ],
      "external_deps_relevant": [
        "<npm package or external module the hypothesis depends on, e.g. three.js, vite>"
      ],
      "notes": "<e.g. 'renderer.ts is the sole importer of three.js — splitting it unblocks the vendor chunk'>"
    },

    "entry_points": [
      <!-- source: EXT-2 (onboarding "Key Entry Points" section) -->
      {
        "entry": "<path:line, e.g. src/main.tsx:12>",
        "kind": "cli | http | browser | test | build",
        "relevance": "<how this entry point relates to the hypothesis — e.g. 'the browser entry that loads the chunk being split'>"
      }
    ],

    "conventions": [
      <!-- source: EXT-2 (onboarding "Conventions" section) + EXT-12 "note conventions" step -->
      "<one-line convention observed in the touched surface, e.g. 'all render modules export a single init() called from main.tsx'>"
    ],

    "gotchas": [
      <!-- source: EXT-2 (onboarding "Where to Look / gotchas") -->
      "<one-line non-obvious risk, e.g. 'vite manualChunks must list three.js explicitly or it lands back in the entry chunk'>"
    ]
  }
}
```

---

## Section-by-section guidance

### overview
One block. Names the product/repo (from `.saga/project.json`), states the
*slice* of the codebase this map covers (anchored on `touches_files`), and the
*purpose* — why the explorer needs this map to judge the hypothesis. If you
cannot state the purpose in one sentence, the hypothesis is underspecified;
record it as a deviation, not a map failure.

<!-- source: EXT-2 https://github.com/affaan-m/everything-claude-code/blob/main/skills/codebase-onboarding/SKILL.md
   (onboarding "Overview" / project-identity block) -->

### module_map
List only the modules in or adjacent to `touches_files`. Each entry carries a
`role_in_experiment` so the synthesis worker can see at a glance whether the
hypothesis stayed in its lane:

- `target` — a file the hypothesis names in `touches_files`.
- `dependency-of-target` — imported/called by a target; the change may ripple here.
- `entry-point` — where execution reaches the target.
- `sibling-affected` — a module that shares an interface or chunk with the target.

<!-- source: EXT-2 (onboarding "Directory Map" with per-module responsibility) -->

### dependency_graph
Directed edges among the mapped modules. `kind` keeps the graph queryable. Only
include `external_deps_relevant` when the hypothesis turns on a third-party
package (bundle size, ESM/CJS, peer-dep). `notes` captures the single load-
bearing insight the explorer used the graph for.

<!-- source: EXT-2 (onboarding "Architecture" / dependency-edges) -->

### entry_points
Concrete `path:line` entries with a `kind` matching our CGAD artifact types
where possible (FR/UC/NFR entry, test harness, build pipeline, browser/CLI).
`relevance` ties each entry back to the hypothesis so synthesis can re-run the
right check.

<!-- source: EXT-2 (onboarding "Key Entry Points") -->

### conventions
Short bullets — the patterns the explorer had to respect to keep the change
idiomatic (naming, file layout, error-handling shape, export style). These are
*observations*, not prescriptions; the explorer does not enforce conventions on
the codebase, it follows them so the sketch lands cleanly.

<!-- source: EXT-2 (onboarding "Conventions") + EXT-12 https://skillsdirectory.com/skills/rsmdt-codebase-exploration
   (reverse-engineering step: "note conventions") -->

### gotchas
Non-obvious risks discovered while mapping — the things that would bite a second
explorer or the synthesis worker. Each gotcha should be actionable: "watch out
for X *because* Y". Empty list is fine; do not invent gotchas.

<!-- source: EXT-2 (onboarding "Where to Look / gotchas") -->

---

## Provenance

| Element | Source |
|---|---|
| Section set (overview, module map, dependency graph, entry points, conventions, gotchas) | EXT-2 codebase-onboarding |
| Per-module responsibility + role-in-experiment framing | EXT-2 onboarding directory map, adapted to CGAD hypothesis scope |
| Conventions section (observe-don't-enforce) | EXT-2 conventions + EXT-12 "note conventions" reverse-engineering step |
| Bounded-scope discipline (map the touched surface, not the whole repo) | EXT-12 codebase-exploration "start broad, then narrow down" |
| CGAD reconciliation (FR/UC/NFR entry kinds, AC-anchored purpose) | this skill — CGAD terminology wins per work order R4 |
