/** Closed policy for retryable Factory-owned failures before OS worker spawn. */
const RETRYABLE_FACTORY_PROVISIONING_CODES = [
  'REPOSITORY_DESK_BASE_MISMATCH',
  'REPOSITORY_DESK_INTEGRATION_HEAD_DRIFT',
] as const;

export function isRetryableFactoryProvisioningFailure(reason: string): boolean {
  return RETRYABLE_FACTORY_PROVISIONING_CODES.some(code => reason.includes(`${code}:`));
}
