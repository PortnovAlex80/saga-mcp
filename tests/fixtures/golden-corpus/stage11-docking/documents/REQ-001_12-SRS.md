# SRS: Physics-Based Spacecraft Docking Simulation

## Status
draft

## 1. Introduction

### 1.1 Purpose
This Software Requirements Specification (SRS) defines the technical architecture and implementation approach for the Physics-Based Spacecraft Docking Simulation. It specifies the system architecture, module boundaries, invariants, and test strategy to realize the acceptance criteria defined in the frozen baseline.

### 1.2 Scope
This SRS covers the implementation of a physics-based docking simulation with the following core capabilities:
- Physics-based spacecraft movement with thrust, rotation, and inertia
- Rotating space station with visible docking port
- Collision detection distinguishing successful docking from hull impact
- Real-time visualization in Chrome browser
- Keyboard input handling for manual control
- Automated docking test with deterministic behavior

The scope is limited to the XS-complexity, sequential workspace defined in the project brief. Cloud deployment, multiplayer capabilities, and full game features are out of scope.

### 1.3 References
- PRD: Physics-Based Spacecraft Docking Simulation (docs/requirements/REQ-001/02-PRD.md)
- Brief: Physics-Based Spacecraft Docking Simulation (docs/requirements/REQ-001/01-brief.md)
- Acceptance Criteria: AC-1 through AC-5 (docs/requirements/REQ-001/11-acceptance-criteria.md)
- Functional Requirements: FR-1 through FR-4 (docs/requirements/REQ-001/03-functional-requirements.md, 04-FR-2-station.md, 05-FR-3-collision.md, 06-FR-4-automated-test.md)
- Non-Functional Requirements: NFR-1, NFR-2 (docs/requirements/REQ-001/07-NFR-1-performance.md, 08-NFR-2-reliability.md)
- Use Cases: UC-1, UC-2 (docs/requirements/REQ-001/10-use-cases.md)
- Business Rule: RULE-1 (docs/requirements/REQ-001/09-RULE-1-determinism.md)

## 2. System Architecture

### 2.1 Architectural Style
**Architectural Style:** Modular Monolith

**Rationale:**
- **Complexity (XS):** The project has XS complexity with a focused, single-domain scope (physics simulation). The total of 5 acceptance criteria and 4 functional requirements indicate a bounded problem space that does not warrant complex architectural patterns.
- **Topology (Sequential):** The system operates as a single sequential workspace with no shared mutation risk across parallel boundaries. A modular monolith provides clear module boundaries without the overhead of ports/adapters.
- **Team Size:** Single-developer project with no need for microservices or distributed deployment.
- **Deployment:** Local execution only via Docker Compose eliminates the need for separate service boundaries.
- **Testability:** Clear module separation enables unit testing while maintaining simplicity for integration and E2E testing.

**Module Boundaries:**
Each module owns its state and exposes a minimal public interface. Internal module state is not shared; communication occurs through explicit function calls and event messages.

### 2.2 Module Manifest

| Module | Responsibilities | Owned Surfaces | Dependencies |
|--------|-----------------|----------------|--------------|
| `physics-core` | Physics simulation: thrust, rotation, inertia, deterministic math | `src/physics/PhysicsEngine.ts`, `src/physics/types.ts` | `simulation-state` |
| `simulation-state` | Centralized state: spacecraft, station, game state, immutable snapshots | `src/state/GameState.ts`, `src/state/types.ts` | `physics-core` |
| `collision-detection` | Collision logic: port vs hull, velocity checks, outcome determination | `src/collision/CollisionDetector.ts`, `src/collision/types.ts` | `simulation-state`, `physics-core` |
| `game-loop` | Main loop: fixed timestep, frame budget, orchestration, timing | `src/game/GameLoop.ts`, `src/game/types.ts` | All modules |
| `renderer-2d` | 2D visualization: Canvas rendering, visual feedback, view layer | `src/renderer/Renderer.ts`, `src/renderer/types.ts` | `simulation-state` |
| `input-handler` | Keyboard input processing: key mapping, state translation | `src/input/InputHandler.ts`, `src/input/types.ts` | `simulation-state` |
| `websocket-server` | Real-time communication: WebSocket, message protocol, connection management | `src/server/WebSocketServer.ts`, `src/server/types.ts` | `simulation-state` |
| `automated-test` | Test automation: autonomous navigation, test execution, reporting | `src/test/AutomatedTest.ts`, `src/test/types.ts` | `simulation-state`, `physics-core`, `collision-detection` |

### 2.3 Port Registry
Not applicable. This modular monolith uses direct module interfaces with explicit function calls rather than formal ports/adapters. The WebSocket module's external interface is the WebSocket protocol itself (client/server contract).

### 2.4 Invariant Registry

| Invariant | Predicate | Check Level | Provider |
|-----------|-----------|-------------|----------|
| **INV-1: Physics Determinism** | `sameInitialState ∧ sameInputs → sameTrajectory` | L0 (Unit), L3 (Property) | `physics-core` |
| **INV-2: Velocity Bounds** | `‖velocity‖ ≤ maxVelocity ∀ t` | L0 (Unit), L3 (Property) | `physics-core` |
| **INV-3: Angular Velocity Bounds** | `‖angularVelocity‖ ≤ maxAngularVelocity ∀ t` | L0 (Unit), L3 (Property) | `physics-core` |
| **INV-4: Position Continuity** | `position(t+δ) - position(t) = O(δ)` | L0 (Unit), L3 (Property) | `physics-core` |
| **INV-5: Station Rotation Determinism** | `stationAngle(t) = stationAngle(0) + rotationRate × t` | L0 (Unit), L3 (Property) | `simulation-state` |
| **INV-6: Docking Port Relativity** | `portPositionWorld(t) = stationPosition(t) + rotationMatrix(stationAngle(t)) × portPositionLocal` | L0 (Unit), L3 (Property) | `simulation-state` |
| **INV-7: Collision Exclusivity** | `isDocked ∧ isCollision = false` | L1 (Integration), L3 (Property) | `collision-detection` |
| **INV-8: Docking Velocity Threshold** | `isDocked → ‖relativeVelocity‖ ≤ DOCKING_VELOCITY_THRESHOLD` | L1 (Integration), L3 (Property) | `collision-detection` |
| **INV-9: Frame Budget** | `frameProcessingTime ≤ FRAME_BUDGET (16.67ms at 60fps)` | L0 (Unit), L2 (Example) | `game-loop` |
| **INV-10: State Immutability** | `historySnapshot.modified = false ∀ t` | L0 (Unit), L1 (Integration) | `simulation-state` |

## 3. External Interfaces

### 3.1 User Interfaces
- **Chrome Browser Canvas:** 2D rendering surface for spacecraft, station, and visual feedback
- **Keyboard Input:** Arrow keys (up/down for thrust, left/right for rotation), Space (restart)
- **WebSocket Client:** Browser-side WebSocket connection for real-time state updates

### 3.2 External Integrations
None. This is a self-contained local simulation with no external services.

## 4. Functional Requirements Allocation

| FR | Owning Module | Implementation Notes |
|----|---------------|---------------------|
| FR-1: Physics-Based Spacecraft Control | `physics-core`, `input-handler` | Thrust adds velocity vector; rotation changes heading; inertia via momentum conservation |
| FR-2: Rotating Space Station with Docking Port | `simulation-state`, `renderer-2d` | Station angle updates by fixed rate; port position computed via 2D rotation matrix |
| FR-3: Collision Detection and Docking | `collision-detection` | Polygon collision for hull; circle/circle for port; velocity threshold for dock success |
| FR-4: Automated Docking Test | `automated-test` | Pre-programmed control sequence or navigation algorithm; deterministic execution |

## 5. Non-Functional Requirements Allocation

| NFR | Owning Module | Implementation Notes |
|----|---------------|---------------------|
| NFR-1: Real-Time Performance | `game-loop`, `renderer-2d`, `websocket-server` | Fixed timestep loop; canvas batching; efficient message protocol |
| NFR-2: System Stability and Reliability | All modules | Error handling; bounds checking; graceful degradation; connection resilience |

## 6. Security Considerations

### 6.1 Security Axes Assessment

| Security Axis | Status | Controls | Rationale |
|---------------|--------|----------|-----------|
| **OWASP Top 10** | n/a | n/a | System runs locally in a sandboxed environment with no external network exposure, authentication, or data persistence. Top 10 web application risks are not applicable to this physics simulation. |
| **ASVS Level** | n/a | n/a | Application Security Verification Standard levels are designed for web applications with authentication, authorization, and session management. This local simulation has no such security boundaries. |
| **Agentic-AI Security** | n/a | n/a | System is a deterministic physics simulation with no AI/ML components, prompt injection surfaces, or autonomous decision-making capabilities that could be manipulated. |
| **Input Validation** | Minimal | Type checking, bounds validation | Input validation focuses on preventing crashes and maintaining simulation stability rather than preventing malicious exploitation. All inputs are numeric vectors with explicit bounds checking. |
| **Resource Exhaustion** | Low | Fixed timestep, frame budget | Game loop enforces fixed timestep (1/60s) and frame budget (16.67ms) to prevent unbounded resource consumption. Simulation runs in isolated Docker container. |
| **Data Exfiltration** | n/a | n/a | No external network connectivity or persistent data storage. All simulation state is ephemeral and contained within the execution environment. |

### 6.2 Security Model

**Threat Model:** The threat model assumes a trusted local execution environment. The primary security concern is preventing accidental system crashes through invalid inputs or resource exhaustion, rather than protecting against malicious actors.

**Trust Boundaries:** 
- Browser client: Trusted (local execution)
- WebSocket server: Trusted (same-origin local connection)
- Docker container: Trusted (isolated local execution)

**Security Posture:** The system operates with a minimal security posture appropriate for a local development/educational tool. Security controls are focused on stability and reliability rather than confidentiality, integrity, or availability in adversarial contexts.

## 7. Data Structures

### 7.1 Core State Objects

```typescript
// Spacecraft state
interface SpacecraftState {
  position: Vector2D;        // x, y position
  velocity: Vector2D;        // vx, vy velocity
  heading: number;           // angle in radians
  angularVelocity: number;   // rotation speed in radians/frame
  mass: number;              // ship mass (for physics calculations)
}

// Station state
interface StationState {
  position: Vector2D;        // center position
  angle: number;             // current rotation angle
  rotationRate: number;      // constant angular velocity
  radius: number;            // station radius
  portAngle: number;         // port position relative to center
  portWidth: number;         // port angular width
}

// Game state
interface GameState {
  spacecraft: SpacecraftState;
  station: StationState;
  status: 'running' | 'docked' | 'collision' | 'timeout';
  time: number;              // simulation time
  frameCount: number;        // total frames rendered
}
```

### 7.2 Physics Types

```typescript
interface Vector2D {
  x: number;
  y: number;
}

interface PhysicsConfig {
  thrustPower: number;           // acceleration magnitude
  rotationSpeed: number;         // angular acceleration magnitude
  dragCoefficient: number;       // velocity decay factor
  maxVelocity: number;           // speed limit
  maxAngularVelocity: number;    // rotation speed limit
  timeStep: number;              // fixed timestep duration
}
```

## 8. Algorithms and Logic

### 8.1 Physics Update (Thrust)
```typescript
function applyThrust(state: SpacecraftState, config: PhysicsConfig, input: InputState): SpacecraftState {
  const acceleration = input.thrust * config.thrustPower;
  const thrustVector = {
    x: acceleration * Math.cos(state.heading),
    y: acceleration * Math.sin(state.heading)
  };
  return {
    ...state,
    velocity: addVectors(state.velocity, thrustVector)
  };
}
```

### 8.2 Physics Update (Rotation)
```typescript
function applyRotation(state: SpacecraftState, config: PhysicsConfig, input: InputState): SpacecraftState {
  const angularAcceleration = input.rotation * config.rotationSpeed;
  return {
    ...state,
    angularVelocity: clamp(state.angularVelocity + angularAcceleration, -config.maxAngularVelocity, config.maxAngularVelocity)
  };
}
```

### 8.3 Physics Update (Integration)
```typescript
function integratePosition(state: SpacecraftState, config: PhysicsConfig, timeStep: number): SpacecraftState {
  // Apply velocity with drag
  const dragFactor = 1 - config.dragCoefficient;
  const dampedVelocity = multiplyVector(state.velocity, dragFactor);
  
  // Update position
  const newPosition = addVectors(state.position, multiplyVector(dampedVelocity, timeStep));
  
  // Update heading
  const newHeading = state.heading + state.angularVelocity * timeStep;
  
  return {
    ...state,
    position: newPosition,
    velocity: dampedVelocity,
    heading: newHeading
  };
}
```

### 8.4 Collision Detection
```typescript
function detectCollision(spacecraft: SpacecraftState, station: StationState): CollisionResult {
  const relativePosition = subtractVectors(spacecraft.position, station.position);
  const distance = magnitude(relativePosition);
  
  // Check hull collision (simple circle)
  if (distance < station.radius + spacecraftRadius) {
    // Check if within docking port sector
    const relativeAngle = normalizeAngle(Math.atan2(relativePosition.y, relativePosition.x) - station.angle);
    const portStart = normalizeAngle(station.portAngle - station.portWidth / 2);
    const portEnd = normalizeAngle(station.portAngle + station.portWidth / 2);
    
    if (isAngleBetween(relativeAngle, portStart, portEnd)) {
      const relativeVelocity = magnitude(spacecraft.velocity);
      if (relativeVelocity <= DOCKING_VELOCITY_THRESHOLD) {
        return { type: 'docked', velocity: relativeVelocity };
      }
    }
    return { type: 'hull_collision', velocity: magnitude(spacecraft.velocity) };
  }
  return { type: 'none' };
}
```

## 9. Test Strategy

### 9.1 Test Layer Definitions

| Layer | Scope | Runner | Target |
|-------|-------|--------|--------|
| **L0 (Unit)** | Single function/class logic | Jest/Vitest | `physics-core`, `collision-detection` |
| **L1 (Integration)** | Multi-component interaction | Jest/Vitest | Module integration points |
| **L2 (Example)** | Specific example scenarios | Jest/Vitest | Builder's examples |
| **L3 (Property)** | General invariant-based tests | Property-based test framework | All invariants |
| **L4 (E2E)** | End-to-end scenario | Automated test + manual verification | Full system |

### 9.2 Unit Test Strategy (L0)
- **Coverage:** Physics functions, collision detection algorithms, state updates
- **Approach:** Isolated unit tests with mock dependencies; deterministic test fixtures
- **Verification:** Correctness of individual functions and invariant preservation

### 9.3 Integration Test Strategy (L1)
- **Coverage:** Module interactions (physics → state → collision → game state)
- **Approach:** Test module interfaces with real dependencies; verify state transitions
- **Verification:** Correct data flow and state mutations across module boundaries

### 9.4 Example Test Strategy (L2)
- **Coverage:** Specific docking scenarios (successful approach, hull impact, high-velocity impact)
- **Approach:** Pre-recorded input sequences with expected outcomes
- **Verification:** Reproducible examples demonstrating AC requirements

### 9.5 Property Test Strategy (L3)
- **Coverage:** Invariant preservation (INV-1 through INV-10)
- **Approach:** Property-based testing with random inputs; deterministic physics parameters
- **Verification:** Invariants hold across randomized valid inputs

### 9.6 E2E Test Strategy (L4)
- **Coverage:** Full system under actual execution
- **Approach:** Automated test module runs full docking sequence; manual verification of visual experience
- **Verification:** Real-world behavior matches expected AC outcomes

### 9.7 Runnable Stack Commands

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Run example tests
npm run test:example

# Run property tests
npm run test:property

# Run E2E tests
npm run test:e2e

# Run automated docking test
npm run test:automated-docking

# Build and run simulation
npm run build
docker compose up
```

## 10. Supporting Systems

### 10.1 Development Tooling

**Version Control:** Git for source code management. No specific branching strategy required for this XS-complexity project.

**Package Management:** npm for JavaScript/TypeScript dependencies. package.json defines runtime and development dependencies.

**Build System:** TypeScript compiler (tsc) for type checking and transpilation. No complex build pipeline required.

### 10.2 Continuous Integration/Continuous Deployment

**Status:** n/a - Not applicable for this local development environment.

**Rationale:** This project is designed for local execution in a Docker Compose environment without remote deployment targets. CI/CD pipelines are not required because:
- No production deployment environment
- No external service dependencies
- Single-developer workflow
- Local testing via npm test commands

If remote deployment were added, a simple GitHub Actions workflow could be added for automated testing and container deployment.

### 10.3 Monitoring and Observability

**Status:** n/a - Minimal monitoring required for local execution.

**Rationale:** The system operates in a local development environment with the following characteristics:
- No production SLA requirements
- No distributed system components
- Direct console output for debugging
- Manual testing and observation sufficient for XS complexity

**Available Monitoring:**
- Console logging from game loop and WebSocket server
- Browser DevTools for client-side debugging
- Docker container logs for server-side debugging
- Frame rate and timing metrics exposed in game state

### 10.4 Logging

**Status:** Minimal logging for development and debugging.

**Logging Strategy:**
- Game loop: Frame timing and state transitions logged to console
- WebSocket server: Connection events and message flow logged
- Physics engine: Optional debug logging for collision events
- Automated test: Test execution results and pass/fail status logged

**Log Levels:** 
- INFO: Normal operation (game state changes, test results)
- DEBUG: Detailed physics calculations and collision detection
- ERROR: Exception conditions and validation failures

**Log Retention:** Ephemeral - logs exist only during container execution. No persistent log storage required.

### 10.5 Deployment

**Status:** Local Docker Compose deployment only.

**Deployment Method:** 
```bash
npm run build    # Build TypeScript to JavaScript
docker compose up # Start containers (simulation server and any dependencies)
```

**Deployment Components:**
- Simulation server container with Node.js runtime
- No database or external service dependencies
- No environment variable configuration required for local execution
- No secrets or sensitive configuration

**Deployment Automation:** n/a - Manual local execution sufficient for this XS-complexity project. Container restart via `docker compose restart` provides adequate deployment control.

### 10.6 Backup and Recovery

**Status:** n/a - No persistent data requires backup.

**Rationale:** All simulation state is ephemeral and generated at runtime. No user data, persistent state, or configuration requires backup. Recovery consists of restarting the simulation or Docker containers.

## 11. External Integration Landscape

### 11.1 External Service Dependencies

**Status:** n/a - No external service dependencies.

**Rationale:** The system is designed as a self-contained local simulation with no external API calls, third-party services, or cloud dependencies. All functionality is implemented within the modular monolith architecture.

### 11.2 External Communication Protocols

**WebSocket Protocol (Local)**

**Protocol:** RFC 6455 WebSocket protocol
**Purpose:** Real-time bidirectional communication between browser client and simulation server
**Implementation:** Native WebSocket API (client) and ws library (server)
**Authentication:** n/a - Local same-origin connection, no authentication required
**Authorization:** n/a - No access control boundaries in local environment
**Rate Limiting:** n/a - Single local client, no rate limiting required

**Message Format:** JSON messages containing game state updates
**Latency Requirements:** < 16.67ms (one frame at 60fps)
**Failure Mode:** Connection loss results in simulation pause; client reconnect attempts on page refresh
**SLA:** n/a - Local development environment, no formal SLA

**Security Considerations:**
- Connection restricted to localhost/local network
- No sensitive data transmitted
- No encryption required for local development
- Input validation on all received messages

### 11.3 Third-Party Libraries

**Status:** Minimal third-party dependencies for core functionality.

**Key Dependencies:**
- **TypeScript:** Language tooling (no runtime dependency)
- **ws:** WebSocket server implementation (MIT license)
- **Jest/Vitest:** Testing framework (dev dependency)
- **Node.js:** Runtime environment

**Dependency Management:**
- All dependencies managed via npm/package.json
- Regular security audits via `npm audit`
- No external CDN dependencies for runtime
- Vendor bundling not required for local execution

### 11.4 External Data Sources

**Status:** n/a - No external data sources.

**Rationale:** All simulation data (physics parameters, initial states, test sequences) is embedded within the codebase. No external APIs, databases, or file system access required beyond local container storage.

### 11.5 Hardware/Platform Dependencies

**Platform Requirements:**
- Chrome browser (for Canvas rendering and WebSocket client)
- Node.js runtime (for simulation server)
- Docker/Docker Compose (for containerized execution)

**Hardware Requirements:** n/a - Standard development hardware sufficient. No specialized hardware (GPUs, accelerators) required for 2D physics simulation.

## 12. Glossary

| Term | Definition |
|------|------------|
| **Spacecraft** | Player-controlled entity with position, velocity, heading, and mass |
| **Station** | Rotating target entity with a docking port at fixed relative position |
| **Docking Port** | Angular sector on the station where successful soft contact can occur |
| **Hull** | Station exterior surface; collision with hull results in failure |
| **Thrust** | Linear acceleration applied in the direction the spacecraft is facing |
| **Rotation** | Angular acceleration changing spacecraft heading |
| **Inertia** | Momentum causing continued movement after input stops |
| **Determinism** | Property that same initial state + same inputs = same outcomes |
| **Time Step** | Fixed duration for each physics update frame (e.g., 1/60s) |
| **Frame Budget** | Maximum allowed time to process one frame (e.g., 16.67ms at 60fps) |

## 13. Out of Scope

The following items are explicitly out of scope for this SRS:
- 3D graphics and visualization
- Multiplayer or networked gameplay
- Mission progression, scoring, or game loop features beyond docking
- Ship customization or multiple ship types
- AI-controlled opponent spacecraft
- Sound effects or audio
- Level design beyond the single docking scenario
- Persistent save/load functionality
- Advanced physics beyond linear and angular momentum
- Integration with external physics engines (custom implementation required)

## 14. Decision Log

| # | Decision | Source | Alternatives | Rationale | Date |
|---|----------|--------|--------------|-----------|------|
| 1 | Modular Monolith Architecture | Inherited from complexity gate (XS, sequential) | Hexagonal, Clean Architecture, Microservices | XS complexity with sequential topology does not warrant port/adapters overhead; modular monolith provides clear boundaries without distribution complexity | 2026-08-19 |
| 2 | 2D Canvas Rendering | PRD technical constraints | WebGL, Three.js, SVG | PRD specifies Chrome-compatible technology; 2D Canvas is sufficient for physics visualization and meets PRD scope; 3D is explicitly out of scope | 2026-08-19 |
| 3 | Custom Physics Engine | RULE-1 determinism requirement | Matter.js, Box2D, Cannon.js | Determinism requirement (RULE-1) mandates precise control over algorithms; custom implementation ensures fixed timestep and deterministic behavior without external dependencies | 2026-08-19 |
| 4 | WebSocket for Real-Time Communication | PRD technical constraints | HTTP polling, Server-Sent Events, WebRTC | WebSocket provides bidirectional low-latency communication suitable for 60fps simulation; polling would introduce latency overhead | 2026-08-19 |
| 5 | Fixed Timestep Game Loop | NFR-1 real-time performance requirement | Variable timestep, RequestAnimationFrame only | Fixed timestep ensures deterministic physics (INV-1) and consistent behavior; RequestAnimationFrame handles rendering synchronization | 2026-08-19 |
| 6 | TypeScript for Backend | PRD technical constraints | JavaScript, Python, Go | PRD explicitly requires TypeScript backend for type safety and maintainability | 2026-08-19 |

## Appendix D: Decomposition Mapping

### §D1 Canonical File/Module Surface

| Module | Canonical Files | Key Interfaces |
|--------|-----------------|----------------|
| `physics-core` | `src/physics/PhysicsEngine.ts`, `src/physics/types.ts` | `applyThrust()`, `applyRotation()`, `integratePosition()` |
| `simulation-state` | `src/state/GameState.ts`, `src/state/types.ts` | `createInitialState()`, `updateState()`, `getStateSnapshot()` |
| `collision-detection` | `src/collision/CollisionDetector.ts`, `src/collision/types.ts` | `detectCollision()`, `checkDockingConditions()` |
| `game-loop` | `src/game/GameLoop.ts`, `src/game/types.ts` | `start()`, `stop()`, `tick()` |
| `renderer-2d` | `src/renderer/Renderer.ts`, `src/renderer/types.ts` | `render()`, `drawSpacecraft()`, `drawStation()` |
| `input-handler` | `src/input/InputHandler.ts`, `src/input/types.ts` | `handleKeyDown()`, `handleKeyUp()`, `getInputState()` |
| `websocket-server` | `src/server/WebSocketServer.ts`, `src/server/types.ts` | `start()`, `broadcastState()`, `handleMessage()` |
| `automated-test` | `src/test/AutomatedTest.ts`, `src/test/types.ts` | `runTest()`, `executeControlSequence()`, `reportResult()` |

### §D2 AC Map

```yaml
- ac: AC-1
  title: Physics-Based Spacecraft Controls
  module: physics-core
  files: [src/physics/PhysicsEngine.ts, src/physics/types.ts, src/input/InputHandler.ts]
  invariants: [INV-1, INV-2, INV-3, INV-4]
  test_layers: [L0, L1, L4]
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker

- ac: AC-2
  title: Rotating Station and Docking Port
  module: simulation-state
  files: [src/state/GameState.ts, src/state/types.ts, src/renderer/Renderer.ts]
  invariants: [INV-5, INV-6]
  test_layers: [L0, L1, L4]
  pattern: A
  depends_on: []
  ac_kind: implementation
  criticality: blocker

- ac: AC-3
  title: Successful Docking Detection
  module: collision-detection
  files: [src/collision/CollisionDetector.ts, src/collision/types.ts]
  invariants: [INV-7, INV-8]
  test_layers: [L1, L4]
  pattern: B
  depends_on: [AC-1, AC-2]
  ac_kind: implementation
  criticality: blocker

- ac: AC-4
  title: Hull Impact Detection
  module: collision-detection
  files: [src/collision/CollisionDetector.ts, src/collision/types.ts]
  invariants: [INV-7]
  test_layers: [L1, L4]
  pattern: B
  depends_on: [AC-1, AC-2]
  ac_kind: implementation
  criticality: blocker

- ac: AC-5
  title: Automated Docking Test
  module: automated-test
  files: [src/test/AutomatedTest.ts, src/test/types.ts]
  invariants: [INV-1, INV-9, INV-10]
  test_layers: [L2, L3, L4]
  pattern: A
  depends_on: [AC-1, AC-2, AC-3, AC-4]
  ac_kind: verification
  criticality: blocker
```

### §D3 Priority Rationale

All ACs are marked as `blocker` criticality because:
- **AC-1, AC-2:** Core physics and station functionality are foundational; without them, docking is impossible
- **AC-3, AC-4:** Collision detection is the core game mechanic; distinguishing success from failure is essential for the simulation's purpose
- **AC-5:** Automated test is a PRD requirement and provides verification of physics determinism (RULE-1); without it, the Factory cannot verify the system

The `verification` ac_kind for AC-5 reflects its role as a test artifact that validates other ACs, rather than implementing core simulation behavior.

### §D4 Decomposition Pattern

**Pattern A (Core Module Implementation):**
- Direct implementation of a functional requirement within a single module
- Self-contained with minimal external dependencies
- Testable at unit and integration levels
- Examples: AC-1 (physics core), AC-2 (station state), AC-5 (automated test)

**Pattern B (Composite Implementation):**
- Implementation spanning multiple modules or requiring coordination between components
- Depends on foundational ACs (Pattern A) for prerequisites
- Testable primarily at integration and E2E levels
- Examples: AC-3 (docking detection), AC-4 (hull impact) both depend on physics and state modules

**Module Cluster:**
- **Physics Cluster:** `physics-core`, `simulation-state` (implements AC-1, AC-2)
- **Collision Cluster:** `collision-detection` (implements AC-3, AC-4 depending on physics cluster)
- **Verification Cluster:** `automated-test` (implements AC-5 depending on all clusters)
- **Support Cluster:** `game-loop`, `renderer-2d`, `input-handler`, `websocket-server` (enabling infrastructure)

This decomposition enables parallel work within clusters and clear dependency ordering between clusters during development.