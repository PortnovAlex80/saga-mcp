# FR-1: Physics-Based Spacecraft Control

## Status
draft

## Description

The system shall provide physics-based spacecraft movement controls including thrust, rotation, and inertia simulation. The spacecraft must respond to keyboard inputs with realistic physics where momentum continues after input stops and the ship rotates around its center.

## Rationale

Authentic physics are fundamental to the Elite-inspired docking experience. Inertia-based movement creates the challenge and skill requirement that distinguishes this from arcade-style games. Users must plan maneuvers in advance and counter momentum, making docking a genuine skill test.

## Acceptance Criteria

- Keyboard inputs control thrust (forward/reverse) and rotation (left/right)
- Spacecraft exhibits inertia: continues moving after thrust input stops
- Spacecraft rotates around its center of mass
- Thrust adds velocity in the direction the ship is facing
- Velocity decays over time (simulating drag) but not instantly
- Rotation has angular velocity and momentum
- Control inputs are responsive but physics-based, not instant position changes
- Ship position and velocity are updated in real-time during simulation

## Notes

Physics parameters (thrust power, rotation speed, drag coefficients) must be tuned to feel realistic while remaining learnable. The physics model should be deterministic for test reliability.