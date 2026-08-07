import type { PostAcceptanceEffect } from '../../process-modules/application/post-acceptance-effects.js';
import { SqliteProductionCellIntegration } from './sqlite-production-cell-integration.js';

export const GIT_INTEGRATION_EFFECT_ID = 'git-integration';

export function createGitIntegrationEffect(
  integration: SqliteProductionCellIntegration,
): PostAcceptanceEffect {
  return {
    effectId: GIT_INTEGRATION_EFFECT_ID,
    run(input) {
      integration.integrateAcceptedWorkplace({
        workplaceRef: input.workplaceRef,
        processRunId: input.processRunId,
        expectedProductSchema: input.expectedProductSchema,
      });
    },
  };
}
