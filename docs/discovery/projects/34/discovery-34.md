# Discovery: GeoSophia Settlement Twin

## Problem

High-speed railway embankments built on weak soil foundations (soft clays, peat, loose sands) experience long-term settlement that can exceed design tolerances, causing track geometry deviations, speed restrictions, and in extreme cases structural failure. Current practice relies on pre-construction geotechnical calculations (PLAXIS FEM, approved analytical methods) and periodic post-construction surveys — but these are static snapshots that cannot detect accelerating consolidation or unexpected soil behavior between survey intervals.

There is no continuous digital twin that ingests real-time instrumentation data (settlement plates, piezometers, inclinometers), compares observed settlement against the approved design model in real time, and alerts engineers when divergence exceeds safety thresholds — all while remaining a non-regulatory shadow system alongside the official calculations.

## Context

- No existing GeoSophia codebase or artifacts were found in the workspace.
- The saga-mcp repository contains D4 discovery-settlement engine files (unrelated to geotechnical settlement).
- This is a greenfield product idea requiring domain research into:
  - Geotechnical instrumentation standards for railway embankments
  - PLAXIS API / data export capabilities for model comparison
  - Railway track geometry tolerances (e.g., UIC, EN 13803)
  - Real-time monitoring systems used in dam/embankment engineering

## Users and Stakeholders

- **Geotechnical engineers** — primary users who design embankments and interpret settlement data; need early warning of model divergence.
- **Railway infrastructure owners/operators** (e.g., RZD, Network Rail) — responsible for track safety and maintenance planning; need risk dashboards and regulatory reports.
- **Construction contractors** — build the embankment layers; need feedback on compaction quality vs design expectations.
- **Regulatory inspectors** — approve construction phases; need auditable evidence that observed behavior matches approved calculations.
- **Monitoring equipment vendors** — provide instrumentation data feeds (piezometers, settlement plates, extensometers).

## Candidate Scope

The minimum useful product is a **shadow-mode settlement risk monitoring service** that:

1. Ingests time-series data from embankment instrumentation (settlement plates, piezometers, inclinometers) via standard protocols (OPC-UA, Modbus, or file-based CSV/JSON).
2. Maintains a simplified 1D consolidation model (Terzaghi primary + secondary compression) calibrated to the approved PLAXIS design parameters for each monitoring point.
3. Computes real-time divergence: observed settlement vs predicted settlement, with configurable alert thresholds (absolute mm and rate mm/day).
4. Produces a risk dashboard showing per-point status (green/yellow/red), trend charts, and divergence reports exportable as PDF for regulatory review.
5. Operates strictly in shadow mode — it does not replace approved calculations; all outputs are labeled "advisory only" with clear disclaimers.

Out of scope for MVP: 2D/3D FEM re-analysis, automated design recalculation, integration with SCADA or train control systems.

## Assumptions

- Instrumentation data is available at monitoring points during and after construction (settlement plates at embankment base and crown, piezometers in the weak layer).
- The approved PLAXIS model parameters (soil layers, consolidation coefficients, loading schedule) can be extracted or manually entered into the system.
- A simplified 1D consolidation model provides sufficient accuracy for early-warning divergence detection (full FEM is not required for shadow monitoring).
- Stakeholders accept a "shadow mode" product that advises but does not replace regulatory calculations.
- Internet connectivity exists at construction sites for data transmission, or edge devices can buffer and sync periodically.

## Unknowns

- What specific instrumentation standards and data formats are used by Russian railway projects (RZD GOST vs international)?
- Can PLAXIS models be exported in a machine-readable format that preserves layer parameters and boundary conditions?
- What are the regulatory requirements for settlement monitoring documentation in Russia (GOST R, SNiP) — can a shadow system's outputs be used as supplementary evidence?
- What is the typical data frequency from instrumentation (hourly, daily, event-triggered)?
- Are there existing commercial solutions (e.g., Bentley GeoStudio Monitoring, Fugro GeoSight) that set market expectations for features and pricing?
- What is the target deployment model: cloud SaaS, on-premise at construction site, or hybrid edge-cloud?

## Risks

- **Technical risk**: 1D consolidation models may produce false positives/negatives compared to actual soil behavior in complex geological conditions (layered soils, anisotropy). The system could miss real risks or generate excessive alerts.
- **Regulatory risk**: Railway safety regulations may not recognize shadow-system outputs; engineers may be reluctant to act on non-certified warnings. In Russia, SNiP and GOST standards govern settlement calculations — deviation from approved methods carries liability.
- **Adoption risk**: Geotechnical engineers are conservative; convincing them to trust a digital twin over their experience and approved calculations requires rigorous validation against known case studies.
- **Data quality risk**: Instrumentation failures (piezometer drift, settlement plate damage during construction) produce gaps or outliers that the system must handle gracefully without generating false alerts.
- **Integration risk**: PLAXIS has limited API; extracting model parameters may require manual entry, introducing transcription errors.

## Evidence

- Task description from Saga MCP: "GeoSophia Settlement Twin — система контроля риска осадки насыпи высокоскоростной железной дороги на слабом основании, работающая в shadow mode рядом с PLAXIS и утверждёнными расчётами."
- No existing codebase or artifacts found in the workspace for this product.
- Domain knowledge: Terzaghi 1D consolidation theory is well-established and widely used for preliminary settlement prediction; PLAXIS is the industry-standard FEM software for geotechnical analysis.

## Recommendation: clarify

The idea addresses a genuine gap in railway embankment monitoring — continuous shadow-mode comparison of observed vs predicted settlement. However, several critical unknowns must be resolved before proceeding to formalization:

1. **Regulatory landscape**: Understand Russian (and target market) requirements for settlement monitoring documentation and whether advisory outputs have any recognized value.
2. **Data availability**: Confirm that instrumentation data feeds are accessible in the target projects and understand the formats, frequencies, and quality expectations.
3. **PLAXIS integration path**: Determine how model parameters will be ingested — API, file export, or manual entry — and the accuracy of each approach.
4. **Competitive landscape**: Research existing solutions (GeoSight, GeoStudio Monitoring) to differentiate and position the product.

Recommend proceeding to a targeted clarification phase addressing these four areas before committing to formalization. The core concept is sound but requires market validation and technical feasibility confirmation.
