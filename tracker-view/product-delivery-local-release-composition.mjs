import { getDb } from '../dist/db.js';
import { createLocalGitReleaseProviders } from '../dist/infrastructure/delivery/local-git-tag-delivery-provider.js';

export const LOCAL_RELEASE_PROFILE = 'local-git-source-tag';

export function createProductLifecycleComposition(context) {
  const providers = createLocalGitReleaseProviders(getDb(), context.projectId);
  return {
    deliveryProfile: LOCAL_RELEASE_PROFILE,
    delivery: {
      providers: {
        preflight: providers.preflight,
        actionProviders: { 'source-tag': providers.sourceTag },
        observeCurrentCandidateHash: providers.observeCurrentCandidateHash,
      },
    },
  };
}

export default createProductLifecycleComposition;
