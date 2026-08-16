# TrackPlan Studio — Application Implementation Plan (English, Agent Handoff Edition)

Version 1.1 (EN). Status: authoritative build plan.
Audience: an autonomous coding agent starting work in a fresh session.

Formatting: plain text (markdown), no decorative elements.

---

# 0. Mission briefing (read this first)

## 0.1. What this is

You are building a web application for automatic railway track plan
realignment: the user uploads a coordinate survey of an existing track, the
system recognizes the plan structure (straights, circular arcs, kinks),
builds a design line with transition curves (clothoids), optimizes design
shifts inside a tolerance corridor, checks normative rules, and supports
interactive editing with immediate recomputation.

This document is the complete, self-contained specification and build plan:
SRS, use cases, acceptance criteria, business rules, the algorithm block,
clean architecture with dependency protection, Docker, parallelization into
subagent waves, git/merge protocol, traceability.

## 0.2. Provenance (why you can trust the algorithm block)

The algorithm is not speculative. It is the synthesis of four independent
design studies (one without skills, three with different skill packs,
run blind, unaware of each other):

- `DELIVERABLE/SKILL_EXPERIMENT/SYNTHESIS.md` — the synthesis (READ THIS).
- `DELIVERABLE/SKILL_EXPERIMENT/agent_sympy/REPORT.md` — exact symbolic
  derivations (versine expansion, clothoid tangent formula, erf-based Fresnel).
- `DELIVERABLE/SKILL_EXPERIMENT/agent_pymoo/REPORT.md` + `agent_pymoo/proto/
  prototype.py` — the only working empirical prototype (~4 min runtime:
  synthetic 600 m section, versines + noise + outliers, mixed-variable
  optimization, 150/150 feasible, true structure K=3 recovered). This is your
  golden reference for the synthetic battery and the AC thresholds.
- `DELIVERABLE/SKILL_EXPERIMENT/agent_uncertainty/REPORT.md` — metrology
  (survey noise model, uncertainty of shifts, nominal-vs-metrological
  guarantee caveat).
- `DELIVERABLE/PLAN_ALGORITHM_REPORT_EN.md` — the reverse-engineered baseline
  (the Whale system, SAPR KRP "Vypravka"): what 20 years of production
  practice considered correct. `verify_2026_08_15/FINDINGS.md` — the evidence.

Eight construction ideas converged independently across all four studies
(curvature-space formulation, exact DP/PELT segmentation, corridor as a linear
operator on curvature, kinks as explicit MDL atoms, robust fitting, KKT
interactivity, chance corridor, the "triad" necessity). Treat them as
consensus, not hypotheses. One empirical law to remember: shift uncertainty
grows as L^(3/2) — on long sections the corridor is not deterministically
reachable (risk table, section 12).

## 0.3. Operating rules for you (the building agent)

1. Repository root: `C:\Users\user\Documents\Kaprem_5.2 (37.2)` — that is the
   workspace. Create the application in a NEW top-level folder `trackplan-app/`
   (do not mix with existing folders).
2. Do not run or modify Whale binaries, dumps, or the reverse-engineering
   artifacts. Read-only references only.
3. Follow the wave plan (section 9). Wave 0 (skeleton, domain, ports) is done
   by a single agent first; its interfaces are then FROZEN (ADR process,
   section 10).
4. Every PR must carry a traceability row (section 8) and tests.
5. CI gates are non-negotiable (section 10.4), especially import-linter and
   the architecture tests: the dependency rule is enforced mechanically,
   not by convention.
6. Numeric truth anchors: scipy is the reference for Fresnel/erf (1e-9);
   the prototype is the reference for battery B1 thresholds.
7. Language of code identifiers and comments: English. The UI is Russian
   (NFR-7); keep normative Russian terms as-is where required.

---

# 1. Purpose and scope

## 1.1. Product

Web application for track plan realignment: upload coordinate survey ->
QC -> automatic structure recognition -> element fitting -> corridor
optimization -> norm checks -> interactive editing -> export.

## 1.2. In scope (release 1.0)

- Input: coordinate survey (X, Y, meters; Z ignored in 1.0).
- Automatic structure recognition, element fitting, shift optimization.
- Shift tolerance corridor (default and per-section, one-sided allowed).
- Normative checks: minimum radius, transition lengths, cant/run-off
  (TsPT-44/17 table as the data source).
- Interactive editing: move element, change radius, fix a parameter,
  with immediate prediction of consequences.
- Export: CSV (elements, shifts), LandXML, report (Markdown/HTML).
- Diagnostics: curvature profile, shift plot, problem list, Pareto front
  (on demand).

## 1.3. Out of scope 1.0 (backlog)

- Versine (chord arrow) input, Gonikberg method — the S0 port extends, the
  core does not change. The exact versine-to-curvature formula is already
  derived (SympPy run of the synthesis):
  f = (c^2/2) kappa + (c^4/24) (kappa'' - kappa^3) — bake it into the port
  design now, implement later.
- Longitudinal profile, cant as a computational block, multi-user,
  collaborative editing, server-side DB (1.0 is file-based project storage).
- Certification features, electronic signature.

## 1.4. Stakeholders

- Track design engineer (primary user).
- Reviewer (inspects diagnostics and report).
- Developer (extends algorithms via ports).

---

# 2. Stack and overall decisions

| Layer | Technology | Rationale |
|---|---|---|
| Frontend | React + TypeScript, SVG + Canvas2D rendering | SVG for interactivity (hit-test, drag); Canvas for dense point clouds (tens of thousands of stations) |
| Graphics | thin custom layer over SVG/Canvas (plan view, curvature profile, shift plot); no heavy engines | full control of coordinate axes/chainage, minimal dependencies |
| Backend | Python 3.12, FastAPI, uvicorn | REST + WebSocket in one process; pydantic typing at the boundary |
| Numeric core | numpy, scipy, osqp (corridor QP), ruptures (PELT) or own DP, own SCP | all designed in SYNTHESIS.md; pymoo optional in phase 2 for Pareto |
| Storage (1.0) | project files (JSON) behind a port adapter | no DB in 1.0; SQLite/Postgres later = new adapter of the same port |
| Build/run | Docker Compose: backend (uvicorn), frontend (nginx + static) | requirement: backend in Docker |
| Quality | pytest, import-linter (architecture contracts), mypy, ruff, coverage gate on domain | dependency protection, see 3.6 |

API contract: OpenAPI generated by FastAPI; the frontend generates its client
(openapi-typescript). WebSocket channel /ws/session/{id} for interactivity.

---

# 3. Architecture

## 3.1. Layers (clean architecture)

```
interfaces/      FastAPI routers, WS handlers, serialization, OpenAPI
application/     use cases (orchestration), DTOs, transaction logic
domain/          entities, value objects, domain services, PORTS (interfaces)
infrastructure/  adapters: solvers, file parsers, storage, normative data
```

Dependency rule: arrows point inward only. `domain` imports nothing except
stdlib and numpy (numpy is an explicit, deliberate exception — domain
quantities are arrays; recorded in ADR-001). `application` knows `domain`.
`infrastructure` implements domain ports. `interfaces` knows `application`.
The single place where concrete implementations are assembled is the
composition root (entrypoints/main.py).

## 3.2. DDD: bounded context and aggregates

One bounded context: Realignment.

Aggregates:
- SurveySession (root): survey points (immutable value), derived profiles
  (curvature with uncertainty), QC flags. Invariants: points ordered by
  station, stations strictly increasing, no duplicates.
- DesignProject (root): DesignLine (element chain), Corridor, NormSet,
  Constraints (fixations), Problems (snapshot of the last check). Invariants:
  the element chain is continuous by chainage; G1 tangency at joints
  (except explicit kink atoms); corridor and norms reference survey stations.

Value objects (frozen dataclasses, explicit units):
Station (m), PointXY, Curvature (1/m), Radius (m), ClothoidParam A (m),
Shift (mm), Versine (mm), CorridorBounds (mm, one-sided/two-sided).

Domain elements (polymorphic chain):
Straight, CircularArc, Clothoid (transition), Kink (an explicit G0 atom).
Common Element interface: begin/end Station, tangent_at(s), point_at(s),
curvature_at(s), shift_of(point) (signed distance to the line).

Domain events (lightweight, no bus): StructureRecognized, ElementEdited,
CorridorViolated, NormsChecked — published by the application layer, written
to the project journal (edit audit).

## 3.3. Ports (interfaces in domain/ports.py)

```
class SurveyIntake(Protocol):        # S0: coordinates -> curvature profile + noise
    def curvature_profile(self, pts: SurveyPointCloud) -> CurvatureProfile: ...

class StructureRecognizer(Protocol): # S1: kappa(s) -> segments (PELT/MDL)
    def recognize(self, prof: CurvatureProfile, cfg: RecognitionConfig)
        -> SegmentPlan: ...

class CorridorSolver(Protocol):      # S2/S3: QP fitting inside the corridor
    def solve(self, plan: SegmentPlan, corridor: Corridor, survey: SurveySession)
        -> FitResult: ...

class GeometryPolisher(Protocol):    # S4: SCP on exact clothoid geometry
    def polish(self, fit: FitResult, iters: int) -> FitResult: ...

class ShiftCalculator(Protocol):    # shifts at stations (operator A + exact recompute)
    def shifts(self, line: DesignLine, survey: SurveySession) -> ShiftSeries: ...

class NormChecker(Protocol):        # normative checks -> problems
    def check(self, line: DesignLine, norms: NormSet) -> list[Problem]: ...

class SensitivityEngine(Protocol):  # KKT answer to an edit (interactivity)
    def predict(self, line: DesignLine, edit: EditRequest) -> EditPrediction: ...

class ProjectStore(Protocol):       # save/load project
    ...
class SurveyReader(Protocol):       # CSV/LandXML -> SurveyPointCloud
    ...
class Exporter(Protocol):           # CSV / LandXML / report
    ...
```

Each port: small, 1-2 methods, data through domain types only.

## 3.4. Package layout

```
trackplan-app/
  backend/
    trackplan/
      domain/
        model/          elements.py, aggregates.py, value_objects.py, events.py
        ports.py        all Protocols
        services/       pure domain logic without external deps:
                        stationing.py, tangency.py, mdl_cost.py, shift_sign.py,
                        operator_a.py
      application/
        usecases/       import_survey.py, recognize.py, fit.py, optimize.py,
                        edit_element.py, check_norms.py, export.py, predict_edit.py
        dto.py
      infrastructure/
        algorithms/     s0_curvature.py, s1_segmentation.py, s2_qp.py,
                        s3_scp.py, shifts.py, sensitivity.py
        io/             csv_reader.py, landxml.py, exporters.py,
                        project_store_fs.py
        norms/          tspt4417.py (data table), norm_repository.py
      interfaces/
        api/            routers_*.py, ws.py, schemas.py
      entrypoints/
        main.py         composition root: wiring, launch
  frontend/
    src/ app/ views/ (PlanView, CurvatureView, ShiftView, ProblemsView)
          components/ render/ (svg-plane, canvas-points) api/ (generated client)
  tests/
    unit/ integration/ arch/ e2e/ battery/
  docker-compose.yml, .env.example, README.md
  docs/ adr/ traceability.md
```

Small classes principle: one class = one responsibility, max ~120 lines;
domain services as module functions where appropriate; a use case = one class
with execute(...), no inheritance.

## 3.5. Skeleton example (style illustration)

```python
# domain/model/elements.py
@dataclass(frozen=True)
class CircularArc(Element):
    begin: Station
    end: Station
    radius: Radius          # > 0; curvature sign is separate
    turn: TurnDirection     # LEFT / RIGHT

    def curvature_at(self, s: Station) -> Curvature: ...
    def point_at(self, s: Station) -> PointXY: ...
    def tangent_at(self, s: Station) -> UnitVector: ...

# application/usecases/recognize.py
class RecognizeStructureUseCase:
    def __init__(self, recognizer: StructureRecognizer, store: ProjectStore):
        self._recognizer = recognizer
        self._store = store

    def execute(self, project_id: ProjectId, cfg: RecognitionConfig) -> SegmentPlanDTO:
        project = self._store.load(project_id)
        plan = self._recognizer.recognize(project.survey.curvature, cfg)
        project.apply(plan)                    # domain logic in the aggregate
        self._store.save(project)
        return SegmentPlanDTO.from_domain(plan)
```

## 3.6. Architecture protection in Python (no compiler — four barriers)

1. Structural: packages by layer; a layer's public API only through its
   `__init__.py` (re-exports); internal modules prefixed with underscore.
2. Declarative (import-linter, config in CI):
   - contract `layers`: interfaces -> application -> domain;
     infrastructure -> domain; infrastructure -x-> application (forbidden);
   - contract `forbidden`: domain -x-> (fastapi|pydantic|osqp|ruptures|uvicorn);
     domain -x-> infrastructure; domain -x-> interfaces;
     application -x-> infrastructure.
3. Testable (pytest arch tests): AST import scan: domain imports nothing
   besides stdlib/numpy/dataclasses/typing; test fails on violation;
   coverage domain >= 95% (gate), application >= 85%.
4. Compositional: the only assembly point is entrypoints/main.py
   (constructor injection, no global state, no service locator). Ports are
   declared in domain; implementations are registered in main.py. Replacing
   a solver = one file in main + a new port implementation.

ADRs in docs/adr/: ADR-001 numpy in domain; ADR-002 file storage in 1.0;
ADR-003 WebSocket for interactivity; ADR-004 no pymoo in release 1.0
(Pareto on demand, phase 2).

---

# 4. Requirements (SRS)

Format: ID, priority (MoSCoW), traceability to use case (UC) and acceptance
criterion (AC). Full matrix in section 8.

## 4.1. Functional requirements

| ID | Requirement | Priority | UC |
|---|---|---|---|
| FR-1 | Import coordinate CSV (X;Y[,Z][;station]), format detection with preview | Must | UC-1 |
| FR-2 | Data QC: duplicates, gaps, outliers (robust), chainage unfolding | Must | UC-2 |
| FR-3 | Survey noise sigma estimate with method shown | Must | UC-2 |
| FR-4 | Curvature profile with confidence band, GCV smoothing | Must | UC-2 |
| FR-5 | Automatic structure recognition (straights/arcs/kinks), MDL calibrated by sigma | Must | UC-3 |
| FR-6 | Initial fitting: Pratt (lines), Kasa + Gauss-Newton (arcs) | Must | UC-3 |
| FR-7 | Shift corridor setup: global and per-section, one-sided/two-sided | Must | UC-5 |
| FR-8 | Shift optimization (QP corridor + SCP polish), status report | Must | UC-6 |
| FR-9 | Transition curves between elements, minimum length checks | Must | UC-6 |
| FR-10 | Normative checks (min radius, clothoids, cant/run-off TsPT-44/17), problem list | Must | UC-8 |
| FR-11 | Editing: move element, radius, clothoid length, parameter fixation | Must | UC-4 |
| FR-12 | Immediate response to an edit (shift/violation prediction < 300 ms round-trip) | Must | UC-4 |
| FR-13 | Export CSV (elements, shifts), LandXML, Markdown report | Must | UC-9 |
| FR-14 | Diagnostics: plan, curvature, shifts, problems; K-vs-shifts Pareto (on demand) | Should | UC-10 |
| FR-15 | Undo/redo of edits (event journal) | Should | UC-4 |
| FR-16 | Project save/load (file), autosave | Must | UC-1 |
| FR-17 | Kink as explicit atom: manual and automatic insert/delete | Should | UC-4/7 |
| FR-18 | Auto-repair of violations: structural operation proposals (insert/merge/delete) | Should | UC-7 |

## 4.2. Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Full pipeline (2 km, 5 m step, ~400 points) | < 10 s server-side |
| NFR-2 | Edit prediction (UC-4) | < 300 ms round-trip (WebSocket) |
| NFR-3 | Startup | docker compose up, zero manual setup |
| NFR-4 | Architecture contracts | import-linter + arch tests green in CI |
| NFR-5 | domain/ unit coverage | >= 95% |
| NFR-6 | Core determinism | same input -> same output (fixed seed in any MOO part) |
| NFR-7 | UI language | Russian; normative terms untranslated |
| NFR-8 | Portability | linux/amd64 containers; project data plain JSON |
| NFR-9 | Input robustness | invalid file -> 4xx + human-readable diagnostics, no crash |
| NFR-10 | Numerical stability | clothoid math via the erf formula; tests against scipy to 1e-9 |

---

# 5. Use cases

Format: actor, preconditions, main flow, alternatives, postconditions.

## UC-1 Import survey
Actor: engineer. Pre: CSV/LandXML file.
Flow: pick file -> preview (columns, N points, spacing) -> confirm ->
SurveySession created (FR-1/2/16), chainage unfolded.
Alternatives: unrecognized columns -> manual mapping; duplicates/gaps ->
warning with resolution (merge/ignore/manual point).
Post: project created, QC available.

## UC-2 Quality control
Actor: engineer. Pre: UC-1.
Flow: curvature profile with uncertainty band; outlier list (robust z-score
of spline residuals); sigma estimate; exclude points (flagged, not deleted).
Post: QC flags saved, sigma fixed for S1 calibration.

## UC-3 Automatic recognition
Actor: engineer. Pre: UC-2.
Flow: "Recognize" -> S1+S2: segments + element parameters -> plan view with
highlighted elements and boundaries -> element table (type, chainage, R/A, L).
Alternatives: manual correction of segment boundaries before fitting.
Post: DesignLine exists; elements tagged by origin (auto/manual).

## UC-4 Interactive editing
Actor: engineer. Pre: UC-3.
Flow: drag an element / change radius / clothoid length / fix a parameter ->
server: prediction (SensitivityEngine) -> client renders prediction ->
confirm -> apply with full recompute (ShiftCalculator, NormChecker) ->
all views update.
Alternatives: edit rejected by an aggregate invariant (tangency) ->
explanatory message.
Post: DesignLine changed, event journal appended, problems recomputed.

## UC-5 Corridor setup
Actor: engineer. Pre: UC-3.
Flow: global corridor (default +/-100 mm) / tabular per section / one-sided.
Overlap validation.
Post: Corridor saved, feasibility status recomputed.

## UC-6 Optimization
Actor: engineer. Pre: UC-3 + UC-5.
Flow: "Optimize" -> QP fit -> SCP polish -> clothoid fitting -> result:
shift table, max/RMS, corridor status; if infeasible -> diagnostics showing
which sections do not fit (with the minimal necessary violation estimate).
Post: shifts optimal at fixed structure.

## UC-7 Structure repair
Actor: engineer. Pre: UC-6 with violations.
Flow: the system proposes operations (insert kink at PK..., merge curves
K1+K2, delete an element) with an effect prediction -> engineer accepts or
rejects -> after applying, automatic return to UC-6.
Post: structure changed, re-optimized.

## UC-8 Norm check
Actor: engineer/reviewer. Pre: UC-6.
Flow: NormChecker -> problem list bound to elements and stations, severity,
normative reference; for radii a cant reference table.
Post: Problems fixed in a project snapshot.

## UC-9 Export
Actor: engineer. Pre: UC-6.
Flow: pick format -> CSV (elements; shifts), LandXML (geometry), report
(Markdown: parameters, shifts, problems, data version).
Post: files produced, validated by schema/parser.

## UC-10 Diagnostics and Pareto
Actor: engineer. Pre: UC-3.
Flow: "Pareto" -> compute the K vs shift-RMS front (sequential S1
relaxations with varying penalty) -> chart + point selection -> load the
corresponding structure.
Post: the engineer chooses the trade-off consciously.

---

# 6. Business rules and the algorithm block

## 6.1. Business rules (BR)

- BR-1 The shift corridor is a hard constraint; optimization may not violate
  it; on incompatibility — a report, never a silent violation.
- BR-2 Objective: minimum number of constant-curvature elements among
  feasible solutions (parsimony, MDL), then minimum total/maximum shifts.
- BR-3 An element with |R| > 5000 m does not count as an arc (candidate for
  a straight or a kink); the threshold is configurable (default from the
  SAPR KRP manual).
- BR-4 A kink is an explicit G0 atom with an angle bound; no "giant-radius
  arcs" in the data model.
- BR-5 Parameter fixation (radius/length) is a hard bound for the optimizer.
- BR-6 Rounding a radius to the normative series is allowed if the computed
  shifts change by at most 10 mm (the OKR rule; journaled). Caveat (synthesis,
  uncertainty run): 10 mm is a nominal (computed) guarantee; the metrological
  noise floor of a shift on an arc is ~24 mm, i.e. changes below ~2 sigma are
  indistinguishable from survey noise. The UI marks the rule as computed;
  the probabilistic treatment is phase 2 (chance corridor).
- BR-7 Survey points are never physically deleted — only flagged excluded.
- BR-8 Every structural operation is logged by an event (audit).
- BR-9 Normative checks use only data from NormRepository (source stated;
  the TsPT-44/17 table is the first record).

## 6.2. Algorithms (ALG) — what exactly is implemented

Formulas are given for implementation; provenance in SYNTHESIS.md and the
four run reports.

- ALG-0 Chainage unfolding: s_i = s_{i-1} + |p_i - p_{i-1}|; duplicates when
  |p_i - p_{i-1}| < eps.
- ALG-1 Smoothing: cubic smoothing spline, GCV parameter; noise sigma via a
  robust MAD estimate of residuals.
- ALG-2 Curvature: kappa(s) = dtheta/ds from spline derivatives; uncertainty
  band by linear propagation of coordinate sigma.
- ALG-3 Segmentation (S1): exact DP (optimal partitioning / PELT) on the
  curvature profile; MDL penalty lambda = 2 sigma_k^2 log n; the segment cost
  goes through the linearized shift operator (NOT curvature SSE); TV denoising
  as initialization/skeleton.
- ALG-4 Shift operator (the key lemma): delta_y(s) = a + b s +
  integral (s - t)_+ delta_kappa(t) dt; discrete form y = A kappa + b,
  A lower-triangular; the linearization is millimeter-accurate for corridors
  of 30-100 mm.
- ALG-5 Lines: Pratt fit (LSQ under a^2+b^2=1, a 2x2 symmetric eigenproblem).
- ALG-6 Arcs: Kasa 3x3 (initialization) -> Gauss-Newton with the residual
  h = 0.5 (d^2 - R^2), 2x2 normal equations for the center at fixed R,
  alternating with R = mean(d) (exactly the Whale scheme, confirmed by the
  SympPy run). Robustness: robust loss (Huber, IRLS weights) in GN and in
  the QP (ALG-7) — the idea that all four blind runs converged on; Kasa is
  only an initializer, out of the main track (bias on short arcs, Chernov).
- ALG-7 Corridor QP (S2/S3): min ||A kappa + b||_2 s.t. |A kappa + b| <= c,
  boxes on element parameters; OSQP solver; optional Huber-IRLS (see ALG-6).

  Pipeline shape rationale ("triad", PRELA empirics): a blind global search
  without recognition seeds is non-viable (0/150 feasible), as is greedy
  polishing from inaccurate starts (it gets stuck); they work only together:
  (1) seeds from exact S1 recognition -> (2) global corridor fit (QP/MOO) ->
  (3) SCP polish + greedy structural operations. The ALG-3 -> ALG-7 -> ALG-8
  conveyor is built exactly this way; in phase 2 (MOO) seeding remains
  mandatory.
- ALG-8 SCP polish (S4): sequential linearization on exact geometry
  (clothoid via complex erf: C+iS = (1+i)/2 erf((1-i) sqrt(pi) x / 2);
  accuracy vs scipy 1e-9 — reference test).
- ALG-9 Clothoid length: solve T(L) = required, T = (R+p) tan(Delta/2) + K;
  monotonicity dT/dL > 0 -> bisection with a uniqueness certificate.
- ALG-10 Kinks: atoms with an angular MDL cost; auto-search = re-run ALG-3
  allowing tangent discontinuities + atom penalty.
- ALG-11 Exact shifts: signed distance point->polyline (element geometry,
  not the linearization) — the final table is always exact.
- ALG-12 Norms: min R; clothoid length from the run-off slope condition
  (TsPT-44/17 table: h mm -> slope); length checks.
- ALG-13 Sensitivity: edit prediction via the KKT system of the last QP fit
  (back-substitution); on degradation — full recompute (fallback).
- ALG-14 Pareto (on demand): a series of ALG-3 solutions along the penalty
  (lambda path), front points K/RMS.

## 6.3. Default parameters

- corridor +/-100 mm (configurable); recognition radius threshold 5000 m;
- operator A node grid: survey step (5-20 m);
- SCP stop: |dy|_inf < 1 mm or 10 iterations;
- MDL penalty: lambda = 2 sigma_k^2 log n (sigma from QC).

---

# 7. Acceptance criteria

## 7.1. Per use case (Given/When/Then, verifiable)

- AC-1 (UC-1): valid CSV 400 points -> project created, 400 stations, status
  "ready for recognition"; invalid (empty, one column) -> HTTP 4xx + message
  with line number.
- AC-2 (UC-2): synthetic input with 5 known outliers -> all 5 listed, zero
  clean points listed; sigma within [0.8, 1.2] x ground truth.
- AC-3 (UC-3): scenario B1 (see 7.3) -> structure K=3 recovered exactly
  (types and order), segment boundaries within +/- 2 stations.
- AC-4 (UC-4): radius drag +50 m -> prediction in < 300 ms, applied, the
  shift table changes consistently (spot-check 3 stations manually in the
  test).
- AC-5 (UC-5): corridor 50 mm while the solution needs 80 mm -> status
  "violation", the section is named; after widening to 100 mm -> "feasible".
- AC-6 (UC-6): B1: shift RMS <= 12 mm, 100% stations inside the corridor,
  runtime < 10 s.
- AC-7 (UC-7): scenario with a forced kink (B3) -> the insert-kink proposal
  names the correct section; after applying — corridor green.
- AC-8 (UC-8): radius 350 m against a 400 m norm -> "min radius" problem,
  severity, bound to the element; a too-short clothoid -> problem.
- AC-9 (UC-9): exported LandXML re-imports losslessly (round-trip test);
  CSV validates against the schema.
- AC-10 (UC-10): the B1 Pareto contains the point K=3/RMS<=12 mm; selecting
  a point loads the corresponding structure.

## 7.2. Non-functional acceptance

- NFR-3: `docker compose up` on a clean machine brings the stack up; both
  healthchecks green in < 60 s.
- NFR-4/5: CI green: import-linter 0 violations; arch tests 0; domain
  coverage >= 95%; mypy strict on domain/application.
- NFR-10: reference tests: Fresnel (erf formula) vs scipy < 1e-9 on a grid
  x in [0, 5]; operator A vs exact recompute < 1 mm for |y| <= 100 mm.

## 7.3. Scenario battery (test data)

Eight code-generated scenarios (fixed seed):
- B1 baseline: straight-clothoid-R500-clothoid-straight-clothoid-R800
  (reverse)-clothoid-straight, 600 m, sigma 1 mm (the PRELA prototype).
- B2 small curves R=300-600, alternating signs.
- B3 long section with a forced kink (corridor 60 mm).
- B4 multi-radius compound curve.
- B5 noise 5 mm + 3% outliers.
- B6 sparse survey (20 m step).
- B7 nearly straight (R=8000) — BR-3 threshold check.
- B8 stress: 5 km, 5 m step (1000 points) — runtime.

Metrics on each: recovered K, boundaries within stations, shift RMS/max,
fraction of stations in corridor, pipeline time, edit-prediction time.
Thresholds live in battery/conftest.py; changing a threshold goes through an
ADR. Ready-made generator: `DELIVERABLE/SKILL_EXPERIMENT/agent_pymoo/proto/
prototype.py` (port its synthetic section).

---

# 8. Traceability matrix (skeleton, maintained in docs/traceability.md)

| REQ | UC | AC | Module | Test | Task (sec. 9) |
|---|---|---|---|---|---|
| FR-1 | UC-1 | AC-1 | infrastructure/io/csv_reader.py | unit csv, e2e import | T-D1 |
| FR-2/3 | UC-2 | AC-2 | application/usecases + algorithms/s0 | unit s0 | T-A1 |
| FR-4 | UC-2 | AC-2 | infrastructure/algorithms/s0_curvature | unit + golden | T-A1 |
| FR-5 | UC-3 | AC-3 | infrastructure/algorithms/s1 | battery B1-B4 | T-A2 |
| FR-6 | UC-3 | AC-3 | infrastructure/algorithms/s1 (fits) | unit fits golden | T-A2 |
| FR-7 | UC-5 | AC-5 | domain/model (Corridor) | unit corridor | T-D2 |
| FR-8 | UC-6 | AC-6 | infrastructure/algorithms/s2/s3 | battery + NFR-10 | T-A3 |
| FR-9 | UC-6 | AC-8 | domain/services/clothoid + ALG-9 | unit monotonic | T-A3 |
| FR-10 | UC-8 | AC-8 | infrastructure/norms | unit norms | T-B1 |
| FR-11/12 | UC-4 | AC-4 | application/predict + infrastructure/sensitivity | integration ws | T-C1 |
| FR-13 | UC-9 | AC-9 | infrastructure/io/exporters | round-trip | T-B2 |
| FR-14 | UC-10 | AC-10 | application/pareto | battery | T-A4 |
| FR-15 | UC-4 | — | domain/events | unit journal | T-D2 |
| FR-16 | UC-1 | AC-1 | infrastructure/io/project_store_fs | integration store | T-B3 |
| FR-17/18 | UC-7 | AC-7 | application/repair | battery B3 | T-C2 |

Rule: a PR without a traceability row is not accepted (CI checks that the
traceability file exists and is referenced).

---

# 9. Implementation plan and subagent parallelization

## 9.1. Phases

- P0 Skeleton (3 days): repository, docker-compose, CI (lint, mypy, pytest,
  import-linter), arch test stubs, OpenAPI skeleton, frontend skeleton.
  Exit: green CI on empty modules.
- P1 Domain (5 days): value objects, aggregates, elements, invariants,
  ports, domain services, events. Exit: domain compiles, coverage >= 95%.
- P2 Vertical slice (10 days): UC-1 -> UC-2 -> UC-3 (S0+S1 without QP):
  CSV import, curvature, segmentation, element table, plan view. Exit:
  demo B1 from file to recognized structure.
- P3 Corridor and optimization (10 days): UC-5, UC-6, ALG-4/7/8/9,
  clothoids, shift plot. Exit: AC-5/6 green on the battery.
- P4 Interactivity (10 days): UC-4, WebSocket, sensitivity, undo/redo,
  fixations, UC-7 (repair). Exit: AC-4/7.
- P5 Norms and export (7 days): UC-8, UC-9, report, LandXML, normative
  data. Exit: AC-8/9.
- P6 Diagnostics and hardening (7 days): UC-10 Pareto, full battery,
  NFR acceptance, documentation (docs/, ADR), release 1.0.

Total: ~52 sequential days; with parallelization the critical path is ~35.

## 9.2. Work split for subagents

Principle: task boundaries coincide with architecture seams (ports); each
task works against frozen interfaces and test doubles (golden files), never
touching other tasks' packages.

Wave 0 (sequential, one agent):
- T-D0 Skeleton + ports + domain types (P0+P1 foundation): repo, layers,
  all Protocols of 3.3, value objects, CI gates. Output: the "contract
  foundation" everyone else builds against.

Wave 1 (4 agents in parallel; depend only on T-D0):
- T-A1 S0 conveyor: csv_reader, stationing, GCV spline, curvature + noise
  (FR-1..4; AC-2). Packages: infrastructure/io/csv_reader.py,
  infrastructure/algorithms/s0_curvature.py.
- T-A2 S1 recognition: DP/PELT with cost via operator A, Pratt/Kasa/GN fits
  (FR-5/6; AC-3). Package: infrastructure/algorithms/s1_segmentation.py.
  Note: operator A is implemented as a domain service function
  (domain/services/operator_a.py) because T-A3 needs it too — the interface
  is fixed by T-D0, the implementation is led by T-A2, T-A3 starts from the
  interface.
- T-B1 Norms + data: NormRepository, TsPT-44/17 table, NormChecker
  (FR-10; AC-8). Packages: infrastructure/norms.
- T-B3 Project storage: project_store_fs, project JSON schema, schema
  version migrations (FR-16). Package: infrastructure/io/project_store_fs.py.

Wave 2 (4 agents in parallel; depend on T-D0 + wave-1 interfaces):
- T-A3 Corridor and polish: QP (OSQP), SCP, clothoids ALG-9, exact shifts
  ALG-11 (FR-8/9; AC-6, NFR-10).
- T-C1 API + WebSocket: FastAPI routers per use case, WS channel, OpenAPI,
  integration tests (FR-11/12 contracts).
- T-F1 Frontend shell + plan view: app, routing, SVG plan with hit-test/drag
  (against an OpenAPI mock server).
- T-B2 Export: exporters CSV/LandXML/report + round-trip tests
  (FR-13; AC-9).

Wave 3 (3 agents in parallel):
- T-C2 Sensitivity + interactivity: KKT prediction, undo/redo, repair
  operations UC-7 (FR-11/12/18; AC-4/7).
- T-F2 Frontend views: curvature, shifts, problems, corridor editor,
  element table, export UI (FR-14 partially).
- T-A4 Pareto + diagnostics: lambda path ALG-14, battery runner (FR-14).

Wave 4 (final, 2 agents):
- T-G1 Battery + NFR acceptance: 8 scenarios, thresholds, B8 load, trace
  ability coverage report.
- T-G2 Documentation and release: docs/, ADR, README, compose finalization,
  release scripts.

Rules for subagents:
1. Work ONLY in your own packages (listed in the task); changes to other
   packages go through an issue to the owning task.
2. Changes to ports/domain are forbidden; a need to change an interface is
   filed as an ADR proposal, applied by T-D0.
3. Every PR carries: code + unit tests + a traceability row + golden files
   (input/output) for its algorithm.
4. Shared test data: the battery generator (T-A4 in wave 3, but the B1
   skeleton is produced by T-D0 in wave 0 so wave 1 does not wait).

## 9.3. Integration order (critical path)

T-D0 -> (T-A1, T-A2, T-B1, T-B3) -> (T-A3, T-C1, T-F1, T-B2) ->
-> (T-C2, T-F2, T-A4) -> (T-G1, T-G2).

Merge points: the end of each wave is an integration week: assembly,
battery B1, demo. Interface incompatibilities are caught by contract tests
(T-C1 owns the OpenAPI contract; the frontend works against the generated
client).

---

# 10. Git: branches, ownership, merge

## 10.1. Model

- main: always green (CI gates: lint, mypy, import-linter, arch tests, unit,
  integration; battery B1 as smoke).
- develop: wave integration branch; goes to main at phase ends (release
  windows).
- feature/{task-id}-{slug}: short-lived task branches (feature/T-A2-
  segmentation). Branch lifetime <= 5 days, otherwise rebase.
- fix/*, spike/* (spikes are never merged; only conclusions as ADRs).

## 10.2. Ownership and conflict protection

- CODEOWNERS per package: domain -> only via the T-D0 owner (review
  mandatory); infrastructure/algorithms -> A-track owner; interfaces/api ->
  C-track; frontend -> F-track; tests/battery, CI -> G-track.
- Interface files (domain/ports.py, the OpenAPI contract, the project
  schema) are declared "frozen": changes only via a separate PR with an ADR
  and two owners' review.
- Conflict isolation: wave tasks do not overlap in files (see 9.2 lists);
  an overlap indicates a planning error, escalate to T-D0.

## 10.3. Merge protocol

1. PR from feature to develop: status checks green, package coverage did
   not drop, traceability row present, golden files attached.
2. Rebase + squash into one atomic commit with the template:
   `[T-A2] S1: PELT segmentation with operator-A cost (FR-5, AC-3)`.
3. Review checklist: architecture boundaries (imports), aggregate
   invariants, determinism (seed), tests at thresholds.
4. develop -> main at phase end: integration tests + full battery; tag
   v0.x.0; changelog from commits.
5. Port/domain conflicts: resolved by ADR, never "last writer wins".

## 10.4. CI gates (mandatory)

- ruff (lint), mypy strict (domain, application),
- import-linter (layer contracts of 3.6),
- pytest: unit + arch + integration; battery B1 as smoke on every PR, full
  battery on develop/main,
- coverage: domain >= 95%, application >= 85%,
- frontend: tsc, eslint, unit (vitest), build,
- docker build of both images (no run on PR, run on develop).

---

# 11. Docker and startup

docker-compose.yml (two services):

- backend: python:3.12-slim; dependencies from pyproject (lock); uvicorn
  app.entrypoints.main:app; volume ./data (projects); healthcheck /healthz;
  port 8000.
- frontend: node:22 build stage -> nginx:alpine (static + proxy /api and
  /ws to backend); port 8080.

Image requirements: pinned versions, multi-stage, no dev dependencies in
runtime, environment variables documented in .env.example. Local development
without Docker is allowed (uvicorn + vite dev), but the CI reference is
compose.

---

# 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Operator-A DP cost insufficiently accurate at large shifts | mandatory SCP polish; NFR-10 test; fallback to full recompute |
| Sensitivity degrades at active constraints | singularity detection -> full recompute (already in ALG-13); share of fast responses tracked in the battery |
| Real surveys differ from synthetic (the main unknown) | battery B5/B6; "soft" import contract (warnings); iterate with a real file at the first opportunity |
| Long sections: corridor deterministically unreachable, sigma_e proportional to L^(3/2) (the PRELA law, confirmed by simulation) | monitored by B8; phase 2 chance corridor (the uncertainty field is already in the DTO); "minimal necessary violation" diagnostics in UC-6 |
| Frontend/backend contract drift | client generated from OpenAPI in CI; hand-written api types forbidden |
| Parallel agents break the architecture | import-linter + arch tests on every PR; frozen interfaces; CODEOWNERS |

---

# 13. Definition of Done

- All Must FR/NFR green in the traceability matrix; every row closed by a
  test.
- Full battery B1-B8 passes at thresholds; B8 within NFR-1.
- docker compose up brings the system up from scratch; the UC-1..UC-9
  scenario runs manually per the README without contacting developers.
- CI: all gates of 10.4; 0 architecture violations.
- Documentation: docs/ (architecture, ADR, algorithms with the ALG-0..14
  formulas, traceability.md up to date).

---

# Appendix A. Algorithm-to-source mapping

Ready-made starting points: the PRELA prototype
(DELIVERABLE/SKILL_EXPERIMENT/agent_pymoo/proto/prototype.py, ~4 min
reproduction: B1 generator, NSGA-II, metrics, oracle) — used in P2 as the
reference for the synthetic generator and the source of the AC-3/AC-6
thresholds; the uncertainty run's metrological tests (agent_uncertainty:
budget_arrow.json, JCGM clause-8) — the basis of the phase-2 uncertainty
tests.

- ALG-4, ALG-7, MDL cost: SYNTHESIS.md (operator-A lemma, lambda/MDL), the
  Curvus/PLK reports.
- ALG-5/6: Pratt 1987, Kasa 1976; the GN residual was extracted from Whale
  (FINDINGS par. 15), the Sampson equivalence confirmed by the SympPy run.
- ALG-8: the erf Fresnel formula (SympPy run; scipy reference).
- ALG-9: the proven exactness of T=(R+p)tan(Delta/2)+K and the monotonicity
  of dT/dL (SympPy run).
- ALG-3: PELT/Potts, threshold sqrt(2 sigma^2 log n); the PRELA lesson:
  the segment cost must go through the shift operator only.
- ALG-10: kinks as MDL atoms (SYNTHESIS sec. 3); emergence confirmed by the
  PRELA prototype (R=165442 m appeared on its own).
- The normative table: lifted from Alignment.dll
  (verify_2026_08_15/math_material/cpt4417_cant_gradient.py).

# Appendix B. Deliberately deferred from the synthesis

- The lambda-relaxation suboptimality certificate (gap) — research after
  1.0: the SolutionCertificate interface is reserved in FitResult now.
- The chance (probabilistic) corridor — phase 2, after noise statistics
  accumulate; the uncertainty field is already in the shift DTO.
- MOO-Pareto as the main path (in 1.0 only diagnostics, ALG-14).
