# Discovery: GeoSophia Settlement Twin — система контроля риска осадки насыпи ВСЖД

## Problem

High-speed railway embankments built on weak soil foundations (soft clays, peat, loose sands) experience long-term settlement that can exceed design tolerances, causing track geometry deviations, speed restrictions, and in extreme cases structural failure. Current practice relies on pre-construction geotechnical calculations (PLAXIS FEM, approved analytical methods per SNiP/GOST) and periodic post-construction surveys — but these are static snapshots that cannot detect accelerating consolidation or unexpected soil behavior between survey intervals.

There is no continuous digital twin that ingests real-time instrumentation data (settlement plates, piezometers, inclinometers), compares observed settlement against the approved design model in real time, and alerts engineers when divergence exceeds safety thresholds — all while remaining a non-regulatory shadow system alongside the official calculations.

For high-speed rail (ВСЖД — высокоскоростная железная дорога), the tolerances are even tighter: track geometry deviations of just 5-10 mm can trigger speed restrictions on lines designed for 250-400 km/h, resulting in significant revenue loss and safety concerns.

## Context

- No existing GeoSophia codebase or artifacts were found in workspace project 35.
- The saga-mcp repository contains the Saga 3 discovery-settlement engine (software framework), unrelated to geotechnical settlement.
- A previous discovery document (discovery-34.md) covers a closely related topic — "GeoSophia Settlement Twin" for general railway embankments — and was recommended as "clarify".
- This is a greenfield product idea requiring domain research into:
  - Geotechnical instrumentation standards for high-speed railway embankments
  - PLAXIS API / data export capabilities for model comparison
  - High-speed rail track geometry tolerances (e.g., UIC 7410-3, EN 13803, Russian GOST R)
  - Real-time monitoring systems used in dam/embankment engineering
  - Russian regulatory framework: SNiP 32-02-01 (railway tracks), SP 34.13330 (foundations)

## Users and Stakeholders

- **Geotechnical engineers** — primary users who design embankments and interpret settlement data; need early warning of model divergence before it becomes a track geometry issue.
- **High-speed railway infrastructure owners/operators** (e.g., RZD, Vysoкоскоростные железные дороги) — responsible for track safety, maintenance planning, and regulatory compliance; need risk dashboards and reports.
- **Construction contractors** — build the embankment layers in sequence; need feedback on compaction quality vs design expectations during construction.
- **Regulatory inspectors** (Rostekhnadzor) — approve construction phases and operational clearance; need auditable evidence that observed behavior matches approved calculations.
- **Monitoring equipment vendors/integrators** — provide instrumentation data feeds (piezometers, settlement plates, extensometers, inclinometers).
- **Project owners/developers** — fund the project; need risk visibility to avoid costly rework or delays.

## Candidate Scope

The minimum useful product is a **shadow-mode settlement risk monitoring service for high-speed rail embankments** that:

1. Ingests time-series data from embankment instrumentation (settlement plates, piezometers, inclinometers) via standard protocols (OPC-UA, Modbus, or file-based CSV/JSON).
2. Maintains a simplified 1D consolidation model (Terzaghi primary + secondary compression) calibrated to the approved PLAXIS design parameters for each monitoring point, with special attention to high-speed rail tolerances.
3. Computes real-time divergence: observed settlement vs predicted settlement, with configurable alert thresholds tuned for ВСЖД requirements (absolute mm and rate mm/day).
4. Produces a risk dashboard showing per-point status (green/yellow/red), trend charts, divergence heatmaps along the embankment alignment, and reports exportable as PDF for regulatory review.
5. Operates strictly in shadow mode — it does not replace approved calculations; all outputs are labeled "advisory only" with clear disclaimers referencing the authoritative calculation method.

Out of scope for MVP: 2D/3D FEM re-analysis, automated design recalculation, integration with SCADA or train control systems, multi-embankment portfolio management.

## Assumptions

- Instrumentation data is available at monitoring points during and after construction (settlement plates at embankment base and crown, piezometers in the weak layer).
- The approved PLAXIS model parameters (soil layers, consolidation coefficients, loading schedule) can be extracted or manually entered into the system.
- A simplified 1D consolidation model provides sufficient accuracy for early-warning divergence detection on high-speed rail embankments (full FEM is not required for shadow monitoring).
- Stakeholders accept a "shadow mode" product that advises but does not replace regulatory calculations per SNiP/GOST.
- Internet connectivity exists at construction sites for data transmission, or edge devices can buffer and sync periodically.
- High-speed rail tolerances (5-10 mm track geometry) are stricter than conventional rail, making early divergence detection more valuable.

## Unknowns

- What specific instrumentation standards and data formats are used by Russian high-speed railway projects (RZD GOST vs international)?
- Can PLAXIS models be exported in a machine-readable format that preserves layer parameters and boundary conditions?
- What are the regulatory requirements for settlement monitoring documentation on ВСЖД in Russia (GOST R, SNiP) — can a shadow system's outputs be used as supplementary evidence?
- What is the typical data frequency from instrumentation (hourly, daily, event-triggered)?
- Are there existing commercial solutions (e.g., Bentley GeoStudio Monitoring, Fugro GeoSight) that set market expectations for features and pricing in the Russian market?
- What is the target deployment model: cloud SaaS, on-premise at construction site, or hybrid edge-cloud?
- How does the product differentiate from the earlier "GeoSophia Settlement Twin" (epic 34) concept — is this a refinement, continuation, or separate initiative?

## Risks

- **Technical risk**: 1D consolidation models may produce false positives/negatives compared to actual soil behavior in complex geological conditions (layered soils, anisotropy). The system could miss real risks or generate excessive alerts.
- **Regulatory risk**: Railway safety regulations (SNiP, GOST) may not recognize shadow-system outputs; engineers may be reluctant to act on non-certified warnings. In Russia, SNiP and GOST standards govern settlement calculations — deviation from approved methods carries liability.
- **Adoption risk**: Geotechnical engineers are conservative; convincing them to trust a digital twin over their experience and approved calculations requires rigorous validation against known case studies.
- **Data quality risk**: Instrumentation failures (piezometer drift, settlement plate damage during construction) produce gaps or outliers that the system must handle gracefully without generating false alerts.
- **Integration risk**: PLAXIS has limited API; extracting model parameters may require manual entry, introducing transcription errors.
- **Market risk**: The Russian high-speed rail market is small (limited ВСЖД projects); the product may need to address international markets or conventional rail to achieve scale.

## Evidence

- Task description from Saga MCP: "GeoSophia Settlement Twin — система контроля риска осадки насыпи высокоскоростной железной дороги на слабом основании, работающая в shadow mode рядом с PLAXIS и утверждёнными расчётами."
- No existing codebase or artifacts found in workspace project 35.
- Previous discovery document (discovery-34.md) covers a closely related concept and was recommended as "clarify".
- Domain knowledge: Terzaghi 1D consolidation theory is well-established for preliminary settlement prediction; PLAXIS is the industry-standard FEM software for geotechnical analysis. High-speed rail tolerances are significantly tighter than conventional rail, increasing the value proposition for continuous monitoring.

## Recommendation: clarify

The idea addresses a genuine and important gap in high-speed railway embankment monitoring — continuous shadow-mode comparison of observed vs predicted settlement with ВСЖД-specific tolerances. However, several critical unknowns must be resolved before proceeding to formalization:

1. **Relationship to epic 34**: The previous discovery (epic 34) covered a nearly identical concept for general railway embankments and was recommended as "clarify". This episode adds the high-speed rail dimension but needs clarification on whether this is a refinement of epic 34 or an independent initiative.
2. **Regulatory landscape**: Understand Russian ВСЖД requirements for settlement monitoring documentation (SNiP 32-02-01, SP 34.13330) and whether advisory outputs have any recognized supplementary value.
3. **Data availability**: Confirm that instrumentation data feeds are accessible in target ВСЖД projects and understand the formats, frequencies, and quality expectations specific to high-speed rail standards.
4. **PLAXIS integration path**: Determine how model parameters will be ingested — API, file export, or manual entry — and the accuracy of each approach for ВСЖД-grade tolerances.
5. **Market sizing**: The Russian high-speed rail market is limited; assess whether the product should target international markets (China, EU) or conventional rail segments to achieve viable scale.

Recommend proceeding to a targeted clarification phase addressing these five areas before committing to formalization. The core concept is sound — continuous shadow monitoring for ВСЖД embankments fills a real need — but requires market validation, regulatory understanding, and technical feasibility confirmation specific to high-speed rail tolerances.
