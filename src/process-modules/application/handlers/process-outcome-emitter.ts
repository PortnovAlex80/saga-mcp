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
 * Generic terminal handler: эмитирует domain event `outcome:<code>` и кладёт
 * код в production bindings. runtimeEvent всегда 'completed' (kernel node).
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
    throw new Error(
      `process-outcome-emitter invoked on node '${ctx.node.id}' `
        + `that has no emitsOutcome — definition is structurally invalid`,
    );
  }
  // The terminal outcome-emitter PRESERVES the certificate envelope from the
  // upstream settlement kernel node (carried in ctx.input.bindings). Without
  // this, the GenericFlowExecutor would lose the authoritative certificate
  // when the terminal node emits its own outcome-only production. The envelope
  // is opaque to this generic handler — it just forwards what the module's
  // settlement kernel produced.
  const upstream = (ctx.input ?? {}) as { bindings?: Record<string, unknown> };
  const upstreamBindings = upstream.bindings ?? {};
  const bindings: Record<string, unknown> = { outcome, ...upstreamBindings };
  return {
    event: `outcome:${outcome}`,
    production: {
      schema: 'factory.process-outcome.v1',
      artifactRef: `outcome:${outcome}`,
      contentHash: outcome,
      bindings,
    },
    outcome,
  };
}
