/**
 * Production Product Lifecycle composition provider — local-dry-run profile.
 *
 * saga4 cutover: this is the ESM module that SAGA_PRODUCT_LIFECYCLE_COMPOSITION
 * points at. It supplies the explicit Delivery composition surface. The runtime
 * (createProductLifecycleRuntime) fills in all standard SQLite-backed
 * implementations and deterministic Reference* policies as defaults, so this
 * provider only needs to declare the parts that composition must NOT fabricate.
 *
 * ## local-dry-run profile
 *
 * This profile is the one the "Start new project from idea" assembler
 * (src/app/start-product-lifecycle-from-idea.ts) binds to. It is FAIL-CLOSED by
 * construction:
 *
 *  - `deliveryProfile` is the typed marker the assembler/test reads to confirm
 *    which profile is installed.
 *  - `publication.publishAndDeploy()` THROWS with the typed outcome
 *    `delivery-provider-not-configured` whenever it is reached. The return type
 *    of the port only allows success shapes (a complete DeliveryPublication
 *    snapshot), so the only fail-closed option is to throw — never fabricate a
 *    publication, an externalRef, a resultHash or a `released` outcome.
 *  - `observation.observe()` returns `{ observed: false }` (advisory only — no
 *    false success signal). It is never reached in the dry-run flow because
 *    publication throws first, but it stays safe in isolation.
 *
 * Critically, this profile does NOT block Discovery, Formalization or
 * Development: those stages never touch the publication/observation providers.
 * Only the Delivery boundary reaches them, and it fails closed there.
 *
 * Real publication (CI deploy, registry publish, git tag/release) must be
 * supplied by a deployment-specific override that replaces this module.
 *
 * Usage:
 *   SAGA_PRODUCT_LIFECYCLE_COMPOSITION=./tracker-view/product-delivery-composition.mjs
 */

/**
 * Typed outcome emitted by the dry-run publication provider. The settlement
 * DeliveryDecision set is `released | approval-required | blocked | failed`; a
 * thrown `delivery-provider-not-configured` resolves to `blocked` at the
 * Delivery boundary (the Process Module treats an adapter throw as an
 * infrastructure failure). It can NEVER resolve to `released`.
 */
export const DRY_RUN_DELIVERY_PROFILE = 'local-dry-run';
export const DRY_RUN_PUBLICATION_REASON_CODE =
  'delivery-provider-not-configured';

/**
 * @param {{ env: NodeJS.ProcessEnv, cwd: string, projectId: number, epicId: number }} context
 */
export function createProductLifecycleComposition(_context) {
  return {
    // Typed marker so the assembler / tests can confirm which profile is bound.
    deliveryProfile: DRY_RUN_DELIVERY_PROFILE,

    // Delivery: pass `providers: {}` so the runtime constructs a
    // SqliteDeliveryRuntime (with SQLite approval inbox + default preflight).
    // Then override publication with fail-closed and observation with advisory.
    // The runtime fills preflightState/approval/settlementState from the runtime.
    delivery: {
      providers: {},
      publication: {
        async publishAndDeploy() {
          // Fail CLOSED. The port's return type only allows a complete success
          // publication snapshot, so throwing is the only safe option. We never
          // synthesize an externalRef, resultHash, or a `released` outcome. A
          // real deployment overrides this with CI/registry/git providers.
          const err = new Error(
            `${DRY_RUN_PUBLICATION_REASON_CODE}: the local-dry-run profile `
            + 'does not publish. Replace this composition with a '
            + 'deployment-specific provider that wires real publication.',
          );
          err.code = DRY_RUN_PUBLICATION_REASON_CODE;
          err.deliveryProfile = DRY_RUN_DELIVERY_PROFILE;
          throw err;
        },
      },
      observation: {
        async observe() {
          // Advisory only — a no-op is safe (no false success signal). Never
          // reached in the dry-run flow because publication throws first.
          return { observed: false, detail: 'observation not configured' };
        },
      },
    },
  };
}

export default createProductLifecycleComposition;
