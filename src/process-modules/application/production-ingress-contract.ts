/**
 * Pre-seal physical ingress selection.
 *
 * This decision is derived only from the immutable WorkIntent capability set.
 * It is erased after exact ProductRefs are resolved and never participates in
 * revision, CandidateSet, Gate, effect, or replay identity.
 */
export type ProductionIngressMode = 'typed-submission' | 'managed-workplace';

export function productionIngressModeFromAuthorityScope(
  authorityScope: string | Readonly<Record<string, unknown>>,
): ProductionIngressMode {
  let scope: Readonly<Record<string, unknown>>;
  if (typeof authorityScope === 'string') {
    try {
      const parsed = JSON.parse(authorityScope) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not-object');
      }
      scope = parsed as Readonly<Record<string, unknown>>;
    } catch {
      throw new Error('PRODUCTION_INGRESS_AUTHORITY_INVALID');
    }
  } else {
    scope = authorityScope;
  }
  if (!Array.isArray(scope.allowed_tools)
    || !scope.allowed_tools.every(tool => typeof tool === 'string')) {
    throw new Error('PRODUCTION_INGRESS_AUTHORITY_INVALID');
  }
  return scope.allowed_tools.includes('product_submit')
    ? 'typed-submission'
    : 'managed-workplace';
}
