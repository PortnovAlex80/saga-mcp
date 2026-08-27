# SEAM.md — the WP03 requirements-bundle validator seam of FRF-WP05

## What the seam is

The typed-refusal AUTHORITY of this Cell's output bundle is the FRF-WP03
pure validator:

```
docs/refactoring/formalization-frf/contracts/validators/requirements-bundle.mjs
  contract identity: frf-contracts.requirements-bundle.v1
  export:            validateRequirementsBundle(bundle, universe)
  schema:            docs/refactoring/formalization-frf/contracts/schemas/requirements-bundle.schema.json
```

Production code (`src/**`) NEVER imports the docs tree: `docs/` is not a
compiled dependency of the build (`tsconfig.json include: ["src/**/*"]`),
and a src→docs import would make the runtime depend on non-runtime
material. Instead the Cell declares a typed seam
(`src/workflow-kernel/workshops/formalization/cells/system-requirements/seam.ts`):

```ts
import { bindWp03RequirementsValidator } from
  '.../cells/system-requirements/seam.js';

const binding = bindWp03RequirementsValidator(wp03Module);  // fail-closed
// binding.bound === true  -> binding.seam.validate(bundle, universe)
// binding.bound === false -> the wp03-validation check is INDETERMINATE
//                            -> the gate yields human-wait (D5)
```

The binder verifies fail-closed, before any validation may run:

1. the module exports `CONTRACT_KIND === 'frf-contracts.requirements-bundle.v1'`
   (no substitute validator is ever bound);
2. the module exports `validateRequirementsBundle` as a function;
3. the SELF-TEST: the bound function must SEAL the fixed probe bundle
   (authored in `seam.ts`) and REFUSE a null product typed
   `MALFORMED_PRODUCT`. An imposter that always returns ok cannot pass.

## Where the binding happens

- AT TEST TIME (this work package): the focused test host dynamically
  imports the docs-tree module and binds it. The canonical binding
  fragment is in
  `tests/workflow-kernel/workshops/formalization/cells/system-requirements/support.mjs`
  (`boundSeam()`), which imports, relative to the repository root:

  ```js
  const WP03_VALIDATOR_PATH = 'docs/refactoring/formalization-frf/contracts/validators/requirements-bundle.mjs';
  ```

- AT COMPOSITION TIME (FRF-WP11, coordinator-owned): the installed
  composition root performs the same dynamic import + binding when the
  Cell package is wired into the installed manifest. Until then the
  package is TEST-ONLY reachable (no production module imports it).

## The fail-closed outcome (never a silent pass)

When the seam is unbound — nothing bound it, or the binder refused the
module — the `system-requirements.check.wp03-validation` CheckPlan check
is INDETERMINATE and the declared gate rule yields `human-wait` on the D5
typed wait `TypedWait:human-input` (discharged via
`workplace.resolveHumanResponse`). There is NO fallback validator, NO
local reimplementation to weaken, and NO path to `accepted` without the
bound WP03 validator sealing the bundle.

## The universe the validator consumes

`deriveAcceptedUniverse(deskInput)` (protocol.ts) builds the WP03
`universe` from the SUPPLIED accepted-id sets — accepted PRD intent
members, accepted UC scenarios + their terminal-branch sets, accepted
source constraints, accepted verification surfaces, and the accepted
PRD/UC revision pins. Fail-closed: a missing set is a typed
`MISSING_LINEAGE` refusal; the Cell never scans, guesses or widens.

## Provenance

- Plan: `docs/plans/FORMALIZATION-SCENARIO-FIRST-REFACTORING-PLAN.md`
  §FRF-WP05 ("your cell's output validates against it" — the WP03
  requirements-bundle contract is the output authority).
- WP03 contracts: `docs/refactoring/formalization-frf/contracts/**`
  (schemas + validators + green/red fixture corpus).
- Seam rule source: FRF coordinator assignment brief for WP04/WP05
  ("import the docs-tree validators at test time through a documented
  seam").
