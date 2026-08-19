# NFR-1: Real-Time Performance

## Status
draft

## Description

The system shall maintain real-time performance sufficient for smooth simulation rendering and responsive controls.

## Rationale

Physics-based docking requires smooth, real-time feedback to feel authentic. Lag or stuttering breaks immersion and makes physics control impossible. Performance is critical for user experience.

## Acceptance Criteria

- Simulation runs at minimum 30fps, target 60fps
- Control inputs are processed within one frame (16ms at 60fps)
- Physics calculations complete within frame budget
- Rendering completes within frame budget
- No noticeable frame drops during normal operation
- System responsive to keyboard input with minimal latency
- Performance remains stable over extended operation

## Notes

Performance requirements assume modern consumer hardware. Browser-based rendering and WebSocket communication must be optimized to meet frame budget. Physics calculations should be efficient.

## Parent Artifacts
- Derived from: PRD (docs/requirements/REQ-001/02-PRD.md)