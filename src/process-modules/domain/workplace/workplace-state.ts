/**
 * Two-channel Workplace state — Kanban phase + machine loop state.
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-28 (Два канала
 * состояния) + Conveyor Mental Model v4 §«Two-channel state: human Kanban and
 * machine loop». Formal invariant: CGAD P18.
 *
 * # Why two channels (the bug this model replaces)
 *
 * Earlier saga collapsed every signal — task status, assignment ownership, log
 * activity, OS process liveness — into ONE growing task-status enumeration. A
 * worker crash therefore looked identical to "work never started", and recovery
 * rolled the card back to `todo`, losing the workplace's continuity. v4 splits
 * the question in two:
 *
 *   - **Kanban state** answers the HUMAN question: "which production stage
 *     owns this card?" (`todo | in_progress | review | review_in_progress |
 *     blocked | done | failed | cancelled`).
 *   - **Workplace loop state** answers the MACHINE question: "what is the
 *     factory doing inside that stage?" (`idle | queued | leased | running |
 *     verifying | repair_wait | paused | terminal`).
 *
 * The split is load-bearing. REG-28-AC-02: "crash, lease expiry and technical
 * repair change loop state, but do NOT roll Kanban back to `todo`." A crashed
 * author leaves the card in `in_progress`; only the loop moves to
 * `repair_wait`. A reviewer-proven product defect is an EXPLICIT semantic
 * backward transition (REG-28-AC-04) `review_in_progress → in_progress`, not a
 * technical crash.
 *
 * `NextRole` (`author | reviewer`) is a SEPARATE field, never folded into the
 * state name — otherwise the core state machine would grow a new status for
 * every workshop and every gate (REG-28 §«value/state machine»).
 *
 * # Pure domain
 *
 * This file imports ONLY sibling pure types. No SQLite, MCP, db.ts, clock, or
 * application/behavioral code. The allowed-pairs table is frozen data; the
 * transition predicates are pure functions over (state, event). The
 * coordinator (step 2.2) and the projection (step 1.3) consume these — they
 * never re-derive the rules.
 */

// ---------------------------------------------------------------------------
// Kanban phase — human-facing production stage.
// ---------------------------------------------------------------------------

/**
 * The closed set of human-visible production stages.
 *
 * Deliberately small and meaningful to a person (REG-28). `in_progress` and
 * `review_in_progress` are ACTIVE production stages — a workplace desk exists
 * for the full lifetime of the Workplace, including the intervals between
 * workers and while a gate checks the product (v4 §«Kanban state»). `done`
 * finishes THIS Workplace; the ProcessRun then materializes the next one with a
 * NEW card — the card does not travel between cells.
 *
 * Frozen literals (FACTORY-DOMAIN-ACCEPTANCE-REGISTRY §6 rule 4: one human
 * word ↔ one identity). Adding a phase requires changing this union AND the
 * allowed-pairs table AND the registry.
 */
export type KanbanPhase =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'review_in_progress'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

/** All Kanban phases, in the order they appear in the union. */
export const KANBAN_PHASES: readonly KanbanPhase[] = [
  'todo',
  'in_progress',
  'review',
  'review_in_progress',
  'blocked',
  'done',
  'failed',
  'cancelled',
] as const;

// ---------------------------------------------------------------------------
// Machine loop state — factory mechanics inside one stage.
// ---------------------------------------------------------------------------

/**
 * The closed set of role-neutral machine-loop states.
 *
 * These names describe FACTORY MECHANICS, not workshop semantics (v4
 * §«Workplace loop state»). A module may declare domain outcomes, but it MUST
 * NOT create a private dispatch or retry state machine (REG-28 §«value/state
 * machine»). `terminal` carries an explicit `TerminalReason` (`accepted |
 * failed | cancelled`) kept in a separate field so the state name stays
 * closed.
 *
 * Frozen literals.
 */
export type LoopState =
  | 'idle'
  | 'queued'
  | 'leased'
  | 'running'
  | 'verifying'
  | 'effect_pending'
  | 'repair_wait'
  | 'paused'
  | 'terminal';

/** All loop states, in declaration order. */
export const LOOP_STATES: readonly LoopState[] = [
  'idle',
  'queued',
  'leased',
  'running',
  'verifying',
  'effect_pending',
  'repair_wait',
  'paused',
  'terminal',
] as const;

// ---------------------------------------------------------------------------
// NextRole and TerminalReason — orthogonal to the loop state name.
// ---------------------------------------------------------------------------

/**
 * Which role the factory will staff next at this workplace.
 *
 * `author | reviewer`. Kept OUT of `LoopState` so the state machine does not
 * grow `queued_for_review`, `running_review`, etc. — those would be a new
 * status per workshop per gate (REG-28). Two workplaces can be `queued` with
 * different `nextRole`; the dispatcher orders reviewer-role work first
 * (REG-10-AC-02).
 */
export type NextRole = 'author' | 'reviewer';

/**
 * Why a workplace entered `terminal`.
 *
 * Kept in a separate field — never in the loop-state name — so `terminal` is a
 * single closed state with three explicit reasons (v4 §«Workplace loop
 * state»). Maps 1:1 to the terminal Kanban phases: `accepted→done`,
 * `failed→failed`, `cancelled→cancelled` (see `terminalReasonForPhase`).
 */
export type TerminalReason = 'accepted' | 'failed' | 'cancelled';

/** All terminal reasons. */
export const TERMINAL_REASONS: readonly TerminalReason[] = [
  'accepted',
  'failed',
  'cancelled',
] as const;

// ---------------------------------------------------------------------------
// Closed table of allowed (Kanban phase, loop state) combinations.
// REG-28-AC-01: "only closed pairs from the Conveyor Mental Model are allowed;
// arbitrary combinations are rejected."
// ---------------------------------------------------------------------------

/**
 * The full set of valid (kanbanPhase, loopState) pairs. Sourced verbatim from
 * v4 §«Allowed channel combinations». Any pair not in this set is a
 * domain-invariant violation and MUST be rejected by the coordinator, the
 * repository CAS, and the projector.
 *
 * `nextRole` is NOT part of this key: both `author` and `reviewer` are allowed
 * wherever the loop state admits staffing (`queued`/`leased`/`running`). The
 * role restriction (`review` phase requires `nextRole=reviewer`,
 * `in_progress` requires `nextRole=author`) is enforced separately by
 * `assertRoleCompatibleWithPhase` — it is a different invariant from the
 * phase-loop pair and is checked independently.
 *
 * The table is a `Set<string>` keyed by `${kanbanPhase}|${loopState}` for O(1)
 * membership. It is frozen at module load; callers must not mutate it.
 */
const ALLOWED_PAIRS: ReadonlySet<string> = new Set<string>([
  // todo — work admitted but not yet leased.
  'todo|idle',
  // in_progress — author loop (REG-28-AC-03 author side).
  'in_progress|queued',
  'in_progress|leased',
  'in_progress|running',
  'in_progress|verifying',
  'in_progress|effect_pending',
  'in_progress|repair_wait',
  // review — reviewer role about to be staffed.
  'review|queued',
  // review_in_progress — reviewer loop (REG-28-AC-03 reviewer side).
  'review_in_progress|queued',
  'review_in_progress|leased',
  'review_in_progress|running',
  'review_in_progress|verifying',
  'review_in_progress|effect_pending',
  'review_in_progress|repair_wait',
  // blocked — human interaction; durable resume target.
  'blocked|paused',
  // terminal phases — one terminal reason each.
  'done|terminal',
  'failed|terminal',
  'cancelled|terminal',
]);

/**
 * Is this (kanbanPhase, loopState) pair allowed by REG-28-AC-01?
 *
 * Pure. Returns false for any combination not in the frozen table. The
 * coordinator calls this before every state mutation; the projector calls it
 * after every rebuild to prove the persisted pair is well-formed.
 */
export function isAllowedPhaseLoopPair(
  kanbanPhase: KanbanPhase,
  loopState: LoopState,
): boolean {
  return ALLOWED_PAIRS.has(`${kanbanPhase}|${loopState}`);
}

/**
 * Assert the pair is allowed; throw with a diagnostic on violation.
 *
 * Used at mutation boundaries (coordinator CAS, repository write) so an
 * invalid pair cannot persist. A separate invariant-scanner test (step 1.4)
 * sweeps the persisted table and fails on any row this rejects.
 */
export function assertAllowedPhaseLoopPair(
  kanbanPhase: KanbanPhase,
  loopState: LoopState,
): void {
  if (!isAllowedPhaseLoopPair(kanbanPhase, loopState)) {
    throw new Error(
      `REG-28-AC-01 violation: Kanban phase '${kanbanPhase}' is not compatible `
        + `with loop state '${loopState}'. Only the closed pairs in `
        + 'ALLOWED_PAIRS (Conveyor Mental Model v4 §Allowed channel '
        + 'combinations) may persist.',
    );
  }
}

/**
 * Which `KanbanPhase` corresponds to a given `TerminalReason`?
 *
 * The 1:1 mapping (REG-28-AC-05): `accepted→done`, `failed→failed`,
 * `cancelled→cancelled`. Used by the coordinator when it applies a terminal
 * transition and by the projector when it reads a `terminal` loop state.
 */
export function terminalReasonForPhase(
  phase: 'done' | 'failed' | 'cancelled',
): TerminalReason {
  switch (phase) {
    case 'done': return 'accepted';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    // No default: the input union is closed.
  }
}

/**
 * Inverse of {@link terminalReasonForPhase}: which terminal Kanban phase does
 * this reason produce?
 */
export function phaseForTerminalReason(
  reason: TerminalReason,
): 'done' | 'failed' | 'cancelled' {
  switch (reason) {
    case 'accepted': return 'done';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
  }
}

/**
 * Is `nextRole` consistent with `kanbanPhase`?
 *
 * A SEPARATE invariant from the phase-loop pair (REG-28-AC-03):
 *   - `in_progress` REQUIRES `nextRole=author` (author loop).
 *   - `review` / `review_in_progress` REQUIRE `nextRole=reviewer`.
 *   - `todo` allows `nextRole=author` (the about-to-be-admitted role).
 *   - terminal/blocked phases have NO next role — any value is ignored, but
 *     callers normally pass `author` as a harmless default.
 *
 * Pure. The coordinator calls this alongside `assertAllowedPhaseLoopPair`
 * before committing a mutation.
 */
export function isRoleCompatibleWithPhase(
  kanbanPhase: KanbanPhase,
  nextRole: NextRole,
): boolean {
  switch (kanbanPhase) {
    case 'in_progress':
      return nextRole === 'author';
    case 'review':
    case 'review_in_progress':
      return nextRole === 'reviewer';
    case 'todo':
      // Work is about to be admitted for an author.
      return nextRole === 'author';
    case 'blocked':
    case 'done':
    case 'failed':
    case 'cancelled':
      // Terminal/paused — no staffing; accept any (ignored by dispatcher).
      return true;
    // No default: KanbanPhase is a closed union.
  }
}

/**
 * The authoritative Workplace state value object.
 *
 * Combines the two channels plus the role and an opaque revision token used
 * for CAS at the repository boundary (REG-05-AC-06: "state transition uses
 * expected revision CAS and is idempotent under replay"). Immutable; the
 * coordinator produces a NEW value for each transition and the repository
 * accepts it only if the persisted revision matches the expected one.
 *
 * This type is the single authoritative state shape. The projector (step 1.3)
 * reads it to build a WorkItem; the coordinator (step 2.2) reads and writes it
 * through the repository's CAS.
 */
export interface WorkplaceState {
  readonly kanbanPhase: KanbanPhase;
  readonly loopState: LoopState;
  readonly nextRole: NextRole;
  /**
   * Monotonic opaque revision token. Bumped on every accepted mutation.
   * Callers pass the revision they read; the repository CAS-matches it.
   */
  readonly revision: number;
  /**
   * Set when `loopState=terminal`. Null otherwise. Required by REG-28-AC-05:
   * `done/failed/cancelled` are compatible only with the matching reason.
   */
  readonly terminalReason: TerminalReason | null;
}

/**
 * Validate a full WorkplaceState at a boundary.
 *
 * Combines all three REG-28 checks:
 *   1. `assertAllowedPhaseLoopPair` — REG-28-AC-01.
 *   2. `isRoleCompatibleWithPhase` — REG-28-AC-03 (non-terminal only).
 *   3. terminal reason ↔ phase consistency — REG-28-AC-05.
 *
 * Throws on any violation. The coordinator and the projector both call this on
 * every value they produce or read, so an invalid state cannot persist or be
 * projected.
 */
export function assertValidWorkplaceState(state: WorkplaceState): void {
  assertAllowedPhaseLoopPair(state.kanbanPhase, state.loopState);
  // Terminal reason are only meaningful when the loop is terminal.
  if (state.loopState === 'terminal') {
    if (state.terminalReason === null) {
      throw new Error(
        'REG-28-AC-05 violation: loopState=terminal requires a terminalReason',
      );
    }
    const expectedPhase = phaseForTerminalReason(state.terminalReason);
    if (state.kanbanPhase !== expectedPhase) {
      throw new Error(
        `REG-28-AC-05 violation: terminalReason='${state.terminalReason}' `
          + `requires kanbanPhase='${expectedPhase}', got '${state.kanbanPhase}'`,
      );
    }
  } else if (state.terminalReason !== null) {
    throw new Error(
      `REG-28-AC-05 violation: non-terminal loopState='${state.loopState}' `
        + 'must have terminalReason=null',
    );
  }
  // Role consistency is only enforceable for non-terminal phases: terminal
  // phases accept any role (the dispatcher ignores it).
  if (state.loopState !== 'terminal'
    && !isRoleCompatibleWithPhase(state.kanbanPhase, state.nextRole)) {
    throw new Error(
      `REG-28-AC-03 violation: kanbanPhase='${state.kanbanPhase}' is not `
        + `compatible with nextRole='${state.nextRole}'`,
    );
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) {
    throw new Error(
      `WorkplaceState.revision must be a non-negative integer, got ${state.revision}`,
    );
  }
}

/**
 * Build the initial WorkplaceState for a freshly materialized singleton cell.
 *
 * A new workplace starts at `todo/idle` with `nextRole=author` and
 * `revision=0` (v4 §«From production order to the first worker»: "kanbanPhase=
 * todo, loopState=idle"). The coordinator calls this once when the ProcessRun
 * activates the cell; every subsequent state is a transition from here.
 */
export function initialWorkplaceState(): WorkplaceState {
  return Object.freeze({
    kanbanPhase: 'todo',
    loopState: 'idle',
    nextRole: 'author',
    revision: 0,
    terminalReason: null,
  }) as WorkplaceState;
}
