/**
 * process-outcome-emitter — generic kernel handler для terminal outcome-узлов.
 *
 * Это единственный handler, который сам живёт в Runtime Core (не поставляется
 * модулем): он тривиален — берёт строку outcome из `node.emitsOutcome` и
 * эмитирует событие. Никакого знания про `go`/`clarify`/`formalized`/...
 *
 * Каждая terminal-node в descriptor'е имеет:
 *   { kind: 'kernel', handler: 'process-outcome-emitter', emitsOutcome: '<code>' }
 *
 * Сам outcome код (например `'go'` для Discovery) — это Module content
 * (он объявлен в `module.outcomes`). handler читает его из узла и возвращает
 * наружу — Runtime не зашивает список кодов.
 */

import type {
  KernelHandlerResult,
  KernelHandlerContext,
} from '../kernel-handler-registry.js';

export const PROCESS_OUTCOME_EMITTER_HANDLER_ID = 'process-outcome-emitter';

/**
 * Generic terminal handler: эмитирует `outcome:<code>` и кладёт код в result.
 *
 * Контракт:
 *   - узел обязан иметь `emitsOutcome` (это уже проверяет структурный валидатор
 *     `validateProcessModuleDefinition` — terminal-узлы обязаны эмитить
 *     объявленный outcome);
 *   - обработчик детерминирован и не имеет побочных эффектов (нет I/O).
 */
export function processOutcomeEmitter(ctx: KernelHandlerContext): KernelHandlerResult {
  const outcome = ctx.node.emitsOutcome;
  if (!outcome) {
    // Этого не должно случиться — валидатор ловит на установке. Но защищаемся.
    throw new Error(
      `process-outcome-emitter invoked on node '${ctx.node.id}' `
        + `that has no emitsOutcome — definition is structurally invalid`,
    );
  }
  return {
    event: `outcome:${outcome}`,
    output: { outcome },
    outcome,
  };
}
