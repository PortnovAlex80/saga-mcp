# Use Cases: Physics-Based Spacecraft Docking Simulation

## Status
draft

## Actors

- **Primary user (Developer)**: Requests the physics-based docking simulation proof-of-concept, tests manual docking functionality
- **Factory system**: Automated test runner requiring verifiable test results
- **Future users**: Developers extending the docking simulation with additional features

## UC-1: Manual Spacecraft Docking

### Actor
Primary user (Developer)

### Precondition
- The docking simulation is running (started via `docker compose up`)
- The spacecraft is positioned at a starting distance from the space station
- The space station is rotating with a visible docking port

### Goal
Successfully dock the spacecraft with the rotating space station using keyboard controls

### Main Flow

1. The user starts the simulation via `docker compose up`
2. The simulation displays the spacecraft at the starting position and the rotating space station with the docking port
3. The user observes the station's rotation to understand the docking port's current position and trajectory
4. The user applies forward thrust by pressing a keyboard key (e.g., arrow up)
5. The spacecraft accelerates based on thrust input, exhibiting inertia (momentum continues after key release)
6. The user applies rotation (left/right) to align the spacecraft's heading toward the predicted docking port position
7. The user navigates toward the station while compensating for the station's rotation and the spacecraft's inertia
8. The user reduces thrust as the spacecraft approaches the docking port
9. The user aligns the spacecraft with the docking port at low relative velocity
10. The spacecraft makes soft contact with the docking port
11. The system detects successful docking and displays a success state

### Alternate Flows

- **Alt Flow 1: Hull Impact**: At step 8-10, if the spacecraft contacts the station hull instead of the docking port, the system detects collision and displays a failure state.
- **Alt Flow 2: High Velocity Impact**: At step 10, if the spacecraft contacts the docking port at excessive velocity, the collision is detected as a failed attempt (not a successful dock).
- **Alt Flow 3: Missed Approach**: At step 7-8, if the spacecraft misses the docking port and passes the station, the user must reverse thrust and reposition for another approach.

### Postconditions

- Successful docking: The spacecraft is docked at the port, the simulation shows success state
- Failed docking (hull impact): The simulation shows failure state, user may restart the simulation

---

## UC-2: Execute Automated Docking Test

### Actor
Factory system (automated test runner)

### Precondition
- The docking simulation is running
- The automated test module is available in the codebase
- The spacecraft is positioned at a known starting state

### Goal
Verify that the spacecraft can successfully dock autonomously and report the test result

### Main Flow

1. The Factory system invokes the automated docking test (via command or build process)
2. The test initializes the simulation with a known starting state
3. The test autonomously controls the spacecraft using a pre-programmed control sequence or navigation algorithm
4. The test monitors spacecraft position, velocity, and station rotation in real-time
5. The test adjusts thrust and rotation inputs to approach the docking port
6. The test aligns the spacecraft with the docking port at low relative velocity
7. The spacecraft achieves soft contact with the docking port
8. The system detects successful docking
9. The test verifies the success condition and reports a pass result
10. The test completes with a clear pass/fail indicator

### Alternate Flows

- **Alt Flow 1: Test Fails**: At step 8-9, if the system detects collision with hull or fails to achieve docking within a time threshold, the test reports a fail result with diagnostic information.
- **Alt Flow 2: Timeout**: At step 7, if the test cannot achieve docking within the maximum allowed time, the test reports a timeout failure.

### Postconditions

- Test result is reported (pass or fail)
- Test execution is repeatable with deterministic results given fixed physics parameters
- Test demonstrates that docking is achievable with the physics model

---

## Traceability Matrix

| UC | Covers FR | Notes |
|---|---|---|
| UC-1: Manual Spacecraft Docking | FR-1: Physics-Based Spacecraft Control | Covers thrust, rotation, inertia controls |
| UC-1: Manual Spacecraft Docking | FR-2: Rotating Space Station with Docking Port | Covers station rotation and docking port approach |
| UC-1: Manual Spacecraft Docking | FR-3: Collision Detection and Docking | Covers successful dock vs hull impact detection |
| UC-2: Execute Automated Docking Test | FR-4: Automated Docking Test | Covers autonomous navigation and test reporting |

## Notes

- Use cases focus on observable user behavior, not internal implementation details
- UC-1 is the primary user-facing scenario for the proof-of-concept
- UC-2 provides verification for the Factory system and demonstrates the physics model is solvable
- Both use cases rely on RULE-1 (Physics Determinism) for reliable, repeatable behavior