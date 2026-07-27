# Discovery: Ballistic Calculator for Moon Colonization Mass Driver (web MVP)

## Problem
Designing and explaining where a mass-driver-launched projectile will travel on the
Moon is currently either trivial-but-wrong or correct-but-inaccessible. Free online
"projectile motion" calculators assume a flat Earth, Earth gravity (~9.81 m/s²), and
often atmospheric drag — none of which apply to the Moon (no atmosphere, ~1.62 m/s²
surface gravity, ~1737 km radius, slow rotation). At the velocities a lunar mass driver
imparts (commonly 1.5–2.4+ km/s for sub-orbital hops, up to ~2.38 km/s lunar escape),
the curvature of the Moon dominates the trajectory, so flat-surface parabolic formulas
are materially wrong. At the other extreme, professional mission-design suites (NASA
GMAT, AGI STK, OpenSees) produce correct physics but are heavy, desktop-licensed,
expensive, and aimed at full orbital missions — overkill and out of reach for a student,
educator, or concept designer who just wants a 10-second "what-if" sketch in a browser.

The opportunity: a fast, in-browser, **3D-visualized lunar mass-driver ballistic
calculator** that occupies the empty niche between "toy projectile calculator" and
"full mission-design suite." The concrete user problem it solves: *"Given a launch
point, a muzzle velocity, and an aim (azimuth/elevation), where does the payload land
on the Moon, how long does it take, and what does the arc look like?"* — answered
accurately enough for concept design, education, and outreach, with an immediate 3D
answer rather than a table of numbers.

A secondary, framing-dependent problem must be called out: the source objective names
the target as a "точки доставки/поражения" (**delivery / strike** point). If the
intent is logistics (delivering ore, water, supplies between surface sites or to
orbit), this is a benign transport-planning tool. If the intent is strike ("поражения"
= defeat/destroy), it becomes a weapon-effects concept with materially different
ethics, scope, and regulatory exposure. This ambiguity is the single most important
open question (see Unknowns and Risks).

## Context
Observed directly in the workspace and Saga tracker (read-only investigation):

- **Greenfield.** `artifact_list({ epic_id: 38 })` returns **0 artifacts** — no PRD,
  UC, AC, FR, or NFR exists yet. This task is the kickoff discovery; there is no prior
  spec to constrain scope.
- **No product code.** `repository_checkout_list({ project_id: 38 })` returns **0
  checkouts.** The bound repository `saga-mcp` is the **Saga tooling host** (the
  discovery/pipeline framework itself), not a product implementation. There is no
  existing ballistic-calculator codebase to extend.
- **No sponsor artifacts.** No notes, comments, or upstream artifacts are attached to
  epic 38 / task 6261 beyond the work intent itself (`work_intent_id: 10258`). The
  project name `BallisticCalc-Moon-Musk` and epic name `Ballistic Calc Discovery` are
  the only framing.
- **Stated MVP focus** (from the work intent): *"качественная 3D-визуализация
  траектории + числовой расчёт"* — qualitative 3D trajectory visualization plus
  numerical calculation. This pins the MVP to visualization + numerics, explicitly
  before high-fidelity simulation.
- **Domain baseline (general aerospace knowledge, not repo evidence):** lunar surface
  gravity ≈ 1.622 m/s², mean radius ≈ 1737.4 km, no atmosphere, sidereal rotation
  period ≈ 27.32 days; lunar escape velocity ≈ 2.38 km/s. A mass driver is an
  established electromagnetic-launch concept studied for lunar resource export. These
  are standard, citable physical facts; they are labeled here as domain knowledge, not
  fabricated file evidence.

## Users and Stakeholders
- **Mission concept designers / aerospace engineering students** — primary. Need fast,
  visual "what-if" trade studies for lunar surface-to-surface or surface-to-orbit
  launch geometry without standing up GMAT/STK.
- **Educators / STEM-outreach communicators** — primary. Need an intuitive 3D visual
  to teach lunar physics, orbital mechanics, and the mass-driver concept.
- **Indie simulation / game developers** — secondary. Want a reference physics model
  for lunar launch mechanics.
- **Space-enthusiast makers / citizen scientists** — secondary. Curiosity-driven
  modeling of "Musk-style" colonization concepts.
- **Product owner / sponsor** — the (currently unidentified) commissioner of the
  "Musk Moon Colonization Mission" themed product. Key stakeholder for intent and
  fidelity decisions.
- **Subject-matter advisor (physics validator)** — needed to sanity-check the solver
  and the assumptions surfaced to users; not yet identified.
- **(Conditional) policy / export-control reviewer** — only relevant if the "strike"
  interpretation is adopted (see Risks).

## Candidate Scope
**Minimum useful product (MVP):** a single-page, client-side browser app. The user
enters a launch position on the Moon, muzzle velocity, launch azimuth, and launch
elevation; the app (1) numerically propagates the projectile under **lunar central
gravity with no atmosphere**, intersecting the lunar sphere to find the impact point,
and (2) renders the arc in **3D** on a lunar globe with launch/impact markers and
orbit-style camera controls. Outputs panel reports: impact coordinates, great-circle
range, flight time, apogee altitude, and peak speed. The smallest thing that delivers
value is **one launch → one 3D arc → one set of landing numbers**, accurate under
lunar physics including curvature (so it stays correct from short hops up to near
escape velocity).

**Explicitly out of MVP (deferred):** multi-body / Earth–Moon transfer, lunar mascon
perturbations, finite-element launch dynamics (rail/capacitor engineering), real lunar
terrain DEMs, multiple simultaneous projectiles, projectile thrust/lift/drag, any
warhead or damage/effects model, backend accounts, and saved scenarios.

**Core MVP modules (3):** (a) physics solver — a numerical integrator (RK4) or analytic
Keplerian surface-intersection under lunar central gravity; (b) 3D renderer —
Three.js/Babylon.js scene with a Moon sphere, trajectory polyline, markers, camera;
(c) UI — input form + outputs panel + play/pause. Assumptions panel surfaced to the
user so the tool never presents simplified physics as authoritative.

## Assumptions
- The Moon is the only gravitating body; projectile is a point mass with no
  post-launch thrust, no lift, and no drag (no atmosphere).
- Surface gravity is modeled as central (inverse-square from the Moon's center), not
  constant-g, so the trajectory stays valid for long hops and near-escape velocities.
- The mass driver imparts an instantaneous muzzle velocity at a fixed elevation/azimuth
  at the surface.
- The target/delivery point is a static location on the lunar surface.
- Computation runs **client-side in the browser** (no backend for MVP) → trivial
  deployment, negligible infra cost; users have a modern WebGL-capable browser.
- The product is a **logistics/education tool** (benign interpretation) pending
  clarification of the "delivery vs. strike" ambiguity.

## Unknowns
- **Intent ambiguity (highest priority):** is this a logistics/delivery planner
  (benign) or a strike/effects tool (weaponized)? The source phrase "доставки/поражения"
  supports both; this materially changes scope, ethics, and regulatory posture and
  cannot be safely assumed away.
- **Required physics fidelity:** does the audience need central-gravity/Keplerian
  accuracy (long hops, near-escape), or would a flat-surface parabola suffice? This
  determines solver complexity and is unresolved.
- **Lunar rotation and mascons:** should the rotating frame (Coriolis) and lunar mass
  concentrations (which measurably destabilize low lunar orbits) be modeled? Relevant
  if trajectories approach orbital altitudes; unknown for MVP.
- **Performance target:** trajectories per second, max projectile count, and minimum
  supported device class are unspecified.
- **Sponsor / customer reality:** no commissioner artifacts exist; it is unknown
  whether there is a real customer or whether this is a speculative/educational
  product — affects whether "go" is warranted at all.
- **Regulatory exposure:** export-control (ITAR/EAR) treatment of launch/trajectory
  software, and Outer Space Treaty / Artemis-Accords implications, are unconfirmed and
  depend entirely on the intent resolution above.

## Risks
- **Regulatory / ethical (high, conditional):** the "strike point" reading would make
  this a space-weapons concept, invoking export control and space-weapons norms. Must
  be resolved to keep the product a logistics/education tool.
- **Fidelity tradeoff / domain accuracy (high):** oversimplified physics (flat Earth,
  constant-g) presented as authoritative is misleading and defeats the purpose;
  mascons/rotation can materially change real results. Must label assumptions and pick
  a defensible fidelity level.
- **"Toy vs. tool" positioning (medium):** too simple → redundant with free online
  calculators; too complex → competes with GMAT/STK and loses. The niche (lunar,
  mass-driver, 3D, in-browser) must be nailed or adoption is zero.
- **Technical (medium):** numerical stability and correct sphere-surface intersection
  for near-escape velocities; in-browser 3D + integrator performance on low-end
  devices; WebGL portability.
- **Sponsorship / sustainability (medium):** greenfield with no confirmed sponsor or
  user base → risk of building a product with no real users.

## Evidence
- Task 6261 description / work intent `work_intent_id: 10258` — defines objective, the
  MVP focus ("3D visualization + numerical calculation"), and the explicit list of
  discovery questions this document answers.
- `artifact_list({ epic_id: 38 })` → **0 artifacts** (evidence of greenfield; no prior
  spec).
- `repository_checkout_list({ project_id: 38 })` → **0 checkouts** (evidence of no
  product code).
- Bound repository is `saga-mcp` — the Saga tooling host, confirming no existing
  ballistic-calculator implementation to extend.
- Lunar physical constants and the mass-driver concept are **general aerospace
  domain knowledge** (standard, widely-published), relied on for the physics framing;
  explicitly labeled as domain knowledge, not fabricated repo citations. No file paths,
  notes, or URLs were invented.

## Recommendation: clarify
The idea is **feasible and the MVP is clearly buildable**: the technical stack
(browser + Three.js/Babylon.js + a lunar-central-gravity solver) is standard, the niche
is real and unoccupied, and the "3D visualization + numerical calculation" focus is
well-scoped. A small team could ship the minimum useful arc (one launch → one 3D arc →
landing numbers) quickly.

However, **two material clarifications should be answered before significant
investment**, and neither can be assumed away reversibly:

1. **Intent — delivery vs. strike ("доставки/поражения").** This single answer changes
   the product from a benign logistics/education tool into a weapon-effects concept,
   reshaping ethics, features, and regulatory exposure. It must be settled by the
   sponsor before build commitment.
2. **Physics fidelity target** (flat-parabola vs. central-gravity/Keplerian) and
   whether rotation/mascons are in scope — this sets the core solver complexity and the
   "toy vs. tool" positioning, and the answer is currently unknown.

A third open question — whether a real sponsor/user base exists — should be confirmed
but is not, on its own, blocking for an MVP-sized, client-side build.

Grounding: the recommendation follows directly from the greenfield evidence (no
artifacts, no checkouts, no sponsor artifacts), the explicit MVP focus in the work
intent, and the unresolved dual-use wording. Outcome chosen as `clarify` rather than
`go` because the intent/fidelity answers materially change what should be built, and as
`clarify` rather than `reject` because the concept is sound and the MVP is low-cost to
deliver once the two questions are answered.
