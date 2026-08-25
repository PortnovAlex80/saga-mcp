/**
 * Reducer registry - one owner per command (WP-05, plan phase EK-2).
 *
 * "Two owners for one fact" is structurally impossible: the registry is
 * validated so that every one of the 53 frozen-universe commands is owned by
 * EXACTLY ONE reducer matching its universe aggregate. A second owner, a
 * missing owner or an illegal edge set is a hard error surfaced by
 * validateRegistry() and asserted blocking in the model tests.
 */

import type { AggregateReducer } from '../types.js';
import { COMMANDS } from '../universe.js';
import { ActivityAttemptReducer } from './activity-attempt.js';
import { CognitionTransportReducer } from './cognition-transport.js';
import { FactoryRunReducer } from './factory-run.js';
import { LifecycleRunReducer } from './lifecycle-run.js';
import { NodeRunReducer } from './node-run.js';
import { ProcessRunReducer } from './process-run.js';
import { validateReducerAgainstUniverse } from './model.js';
import { StageRunReducer } from './stage-run.js';
import { WorkItemReducer } from './work-item.js';
import { WorkplaceReducer } from './workplace.js';

export const REDUCERS: readonly AggregateReducer[] = [
  FactoryRunReducer,
  LifecycleRunReducer,
  StageRunReducer,
  ProcessRunReducer,
  NodeRunReducer,
  WorkplaceReducer,
  ActivityAttemptReducer,
  WorkItemReducer,
  CognitionTransportReducer,
];

export function reducerForAggregate(aggregate: string): AggregateReducer | undefined {
  return REDUCERS.find((reducer) => reducer.aggregate === aggregate);
}

export function reducerForCommand(command: string): { reducer: AggregateReducer; descriptor: (typeof COMMANDS)[number] } | undefined {
  const descriptor = COMMANDS.find((entry) => entry.name === command);
  if (!descriptor) return undefined;
  const reducer = REDUCERS.find((entry) => entry.ownedCommands.includes(descriptor.name));
  if (!reducer) return undefined;
  return { reducer, descriptor };
}

/**
 * Validate the one-owner law and every reducer's edge set against the frozen
 * universe. Returns the list of problems (empty = valid).
 */
export function validateRegistry(): string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>();
  for (const reducer of REDUCERS) {
    problems.push(...validateReducerAgainstUniverse(reducer));
    for (const command of reducer.ownedCommands) {
      const existing = owners.get(command);
      if (existing) {
        problems.push(`command ${command} has TWO owners: ${existing} and ${reducer.aggregate}`);
      } else {
        owners.set(command, reducer.aggregate);
      }
    }
  }
  for (const descriptor of COMMANDS) {
    if (!owners.has(descriptor.name)) {
      problems.push(`universe command ${descriptor.name} has NO owning reducer`);
    }
  }
  const aggregates = new Set(REDUCERS.map((reducer) => reducer.aggregate));
  if (aggregates.size !== REDUCERS.length) {
    problems.push('two reducers declare the same aggregate');
  }
  return problems;
}
