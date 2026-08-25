/**
 * workflow-kernel/domain/reducers/model.ts - shared pure guard builders for
 * the aggregate reducers (WP-05, plan phase EK-2).
 *
 * Every helper is pure: it inspects the read-only guard context and returns
 * typed refusals or required-evidence declarations. No I/O, no clock, no
 * randomness.
 */

import type {
  AggregateReducer,
  CommandGuard,
  CommandInput,
  GuardContext,
  RefusalReason,
  TypedRefusal,
} from '../types.js';
import type { EvidenceKind, ProofKind } from '../universe.js';
import { COMMANDS } from '../universe.js';

/** Build a typed refusal (never a silent fallback). */
export function refuse(reason: RefusalReason, detail: string): TypedRefusal {
  return { refused: true, reason, detail };
}

/** True iff at least one evidence fact of the exact kind exists. */
export function hasEvidenceKind(ctx: GuardContext, kind: string): boolean {
  for (const fact of ctx.evidence.values()) {
    if (fact.kind === kind) return true;
  }
  return false;
}

/** True iff a terminal proof with the exact proof kind was issued in the world. */
export function hasProofKind(ctx: GuardContext, id: string): boolean {
  return ctx.proofs.some((proof) => proof.id === id);
}

/** True iff an obligation of the exact kind is open and targets the command. */
export function hasOpenObligationFor(ctx: GuardContext, target: string): boolean {
  return ctx.openObligations.some((obligation) => obligation.target === target && obligation.state === 'open');
}

/**
 * Guard requiring every listed evidence/proof kind to exist. Missing kinds
 * produce a MISSING_EVIDENCE refusal naming the exact kind.
 */
export function requireEvidence(kinds: readonly (string | ProofKind)[]): CommandGuard {
  return (_input: CommandInput, _head, ctx) => {
    for (const kind of kinds) {
      const present = kind.startsWith('TerminalProof:')
        ? hasProofKind(ctx, kind as ProofKind)
        : hasEvidenceKind(ctx, kind);
      if (!present) {
        return refuse('MISSING_EVIDENCE', `${kind} is required before this transition may commit`);
      }
    }
    return { requiredEvidenceKinds: kinds as readonly (EvidenceKind | ProofKind)[] };
  };
}

/**
 * The universe descriptor of one command (name -> declared transition).
 * Guards and the engine share this single declaration source.
 */
export function descriptorOf(command: string): (typeof COMMANDS)[number] {
  const descriptor = COMMANDS.find((entry) => entry.name === command);
  if (!descriptor) {
    throw new Error(`UNIVERSE_VIOLATION: command ${command} is not declared in the frozen transition universe`);
  }
  return descriptor;
}

/**
 * Validate that a reducer's declared edges are exactly the universe's
 * commands for its aggregate: same owned command set, every declared
 * obligation/wait/proof kind real. Used by the registry (one owner per
 * command) and by the model tests.
 */
export function validateReducerAgainstUniverse(reducer: AggregateReducer): string[] {
  const problems: string[] = [];
  const owned = new Set(reducer.ownedCommands);
  for (const command of COMMANDS) {
    if (command.aggregate === reducer.aggregate && !owned.has(command.name)) {
      problems.push(`${reducer.aggregate}: universe command ${command.name} is not owned by the reducer`);
    }
    if (command.aggregate !== reducer.aggregate && owned.has(command.name)) {
      problems.push(`${reducer.aggregate}: reducer owns ${command.name} which the universe assigns to ${command.aggregate}`);
    }
  }
  for (const rule of reducer.transitions) {
    if (!owned.has(rule.command)) {
      problems.push(`${reducer.aggregate}: transition rule names unowned command ${rule.command}`);
      continue;
    }
    for (const status of rule.fromStatuses) {
      if (!reducer.statuses.includes(status)) {
        problems.push(`${reducer.aggregate}: rule for ${rule.command} references unknown fromStatus ${status}`);
      }
    }
    if (rule.toStatus !== '*' && !reducer.statuses.includes(rule.toStatus)) {
      problems.push(`${reducer.aggregate}: rule for ${rule.command} references unknown toStatus ${rule.toStatus}`);
    }
    if (rule.toStatus === '*' && rule.terminal) {
      problems.push(`${reducer.aggregate}: status-preserving rule for ${rule.command} cannot be terminal`);
    }
    if (rule.terminal !== (rule.toStatus !== '*' && reducer.terminalStatuses.includes(rule.toStatus))) {
      problems.push(`${reducer.aggregate}: terminal flag mismatch for ${rule.command} -> ${rule.toStatus}`);
    }
  }
  const covered = new Set(reducer.transitions.map((rule) => rule.command));
  for (const command of owned) {
    if (!covered.has(command)) {
      problems.push(`${reducer.aggregate}: owned command ${command} has no transition rule`);
    }
  }
  return problems;
}
