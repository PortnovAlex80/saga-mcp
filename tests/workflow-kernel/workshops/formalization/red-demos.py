"""WP-11F RED demonstration patcher: applies ONE deliberate source mutation,
runs the pinned suite, and restores. Never leaves a mutation behind.

One killed mutation per fence family:
  ingress-digest-fence       capsule self-address verification (ingress.ts)
  gate-provider-fence        declared-provider fail-closed check (gates.ts)
  role-reresolve-fence       one-resolution-per-launch-kind cache (roles.ts)
  material-chain-fence       accepted-material fold ignores the artifact (contribution.ts)
  effect-idempotency-fence   applied-key ledger ignored on re-execute (effects.ts)
  baseline-drift-fence       exact member-set equality disabled (products.ts)
  driver-universe-fence      an undeclared command id composed (driver.ts)
"""
import io
import subprocess
import sys

MUTATIONS = {
    'ingress-digest-fence': {
        'file': 'src/workflow-kernel/workshops/formalization/ingress.ts',
        'old': """  if (sha256OfCanonical(factBody) !== capsule.capsuleDigest || capsule.capsuleRef !== `sha256:${capsule.capsuleDigest}`) {
    return refused('BYTES_CORRUPT', 'the capsule self-address does not verify against its canonical facts (corrupt capsule bytes)');
  }""",
        'new': "  /* MUTATION: capsule digest fence disabled */ if (false) { return refused('BYTES_CORRUPT', 'mutated'); }",
        'suite': 'tests/workflow-kernel/workshops/formalization/ingress.test.mjs',
    },
    'gate-provider-fence': {
        'file': 'src/workflow-kernel/workshops/formalization/gates.ts',
        'old': """  const installed = FORMALIZATION_CHECK_PROVIDERS.find((entry) => entry.providerId === provider.providerId);
  if (
    installed === undefined ||""",
        'new': """  const installed = FORMALIZATION_CHECK_PROVIDERS.find((entry) => entry.providerId === provider.providerId);
  if (
    false ||""",
        'suite': 'tests/workflow-kernel/workshops/formalization/gates.test.mjs',
    },
    'role-reresolve-fence': {
        'file': 'src/workflow-kernel/workshops/formalization/roles.ts',
        'old': """  resolveOnce(launchKind: string): FormalizationRoleResolution {
    const cached = this.slots.get(launchKind);
    if (cached !== undefined) {
      return { resolved: true, slot: cached };
    }""",
        'new': """  resolveOnce(launchKind: string): FormalizationRoleResolution {
    const cached = this.slots.get(launchKind);
    if (false) {
      return { resolved: true, slot: cached };
    }""",
        'suite': 'tests/workflow-kernel/workshops/formalization/roles.test.mjs',
    },
    'material-chain-fence': {
        'file': 'src/workflow-kernel/workshops/formalization/contribution.ts',
        'old': """      return {
        ...accepted,
        prd: {
          revisionDigest,
          memberIds: [...memberIds],
          scenarioRequiredMemberIds: accepted.prd?.scenarioRequiredMemberIds ?? [],
        },
      };""",
        'new': """      /* MUTATION: the fold drops the accepted member ids (the chain loses its lineage) */
      return {
        ...accepted,
        prd: {
          revisionDigest,
          memberIds: [],
          scenarioRequiredMemberIds: accepted.prd?.scenarioRequiredMemberIds ?? [],
        },
      };""",
        'suite': 'tests/workflow-kernel/workshops/formalization/products.test.mjs',
    },
    'effect-idempotency-fence': {
        'file': 'src/workflow-kernel/workshops/formalization/effects.ts',
        'old': """    const actionKey = FormalizationEffectExecutor.actionKeyOf(effectId, contentDigest);
    const already = this.applied.get(actionKey);
    if (already !== undefined) {
      return { effectId, actionKey, outcome: 'already-applied', receiptDigest: already };
    }""",
        'new': """    const actionKey = FormalizationEffectExecutor.actionKeyOf(effectId, contentDigest);
    const already = undefined as string | undefined;
    if (already !== undefined) {
      return { effectId, actionKey, outcome: 'already-applied', receiptDigest: already };
    }""",
        'suite': 'tests/workflow-kernel/workshops/formalization/effects.test.mjs',
    },
    'baseline-drift-fence': {
        'file': 'src/workflow-kernel/workshops/formalization/products.ts',
        'old': """  const expectedMembers = [...expected.memberDigests].sort();
  const actualMembers = [...product.memberDigests].sort();
  if (actualMembers.join(',') !== expectedMembers.join(',')) {""",
        'new': """  const expectedMembers = [...expected.memberDigests].sort();
  const actualMembers = [...product.memberDigests].sort();
  if (false) {""",
        'suite': 'tests/workflow-kernel/workshops/formalization/products.test.mjs',
    },
    'driver-universe-fence': {
        'file': 'src/workflow-kernel/workshops/formalization/driver.ts',
        'old': "  const kernel = consumeKindOn(session, 'obligation:freezeCandidate', 'nodeRun.recordKernelResult', binding.node, {}, config);",
        'new': "  const kernel = consumeKindOn(session, 'obligation:freezeCandidate', 'nodeRun.recordKernelResultX' as CommandName, binding.node, {}, config);",
        'suite': 'tests/workflow-kernel/workshops/formalization/structure.test.mjs',
    },
}


def run(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')


def main():
    names = sys.argv[1:] or list(MUTATIONS)
    failures = []
    for name in names:
        mutation = MUTATIONS[name]
        path = mutation['file']
        original = io.open(path, encoding='utf8').read()
        if mutation['old'] not in original:
            print(f'PATTERN NOT FOUND for {name}')
            failures.append(name)
            continue
        mutated = original.replace(mutation['old'], mutation['new'])
        io.open(path, 'w', encoding='utf8', newline='\n').write(mutated)
        try:
            run('npm run build')
            result = run(f'node --test "{mutation["suite"]}" 2>&1')
            tail = '\n'.join(result.stdout.strip().splitlines()[-6:])
            import re as _re
            red = any(_re.match(r'ℹ fail [1-9]', line) or _re.search(r'fail [1-9]', line) for line in result.stdout.splitlines())
            status = 'RED (killed)' if red else 'NOT RED (mutation survived!)'
            if not red:
                failures.append(name)
            print(f'=== {name}: {status} ===')
            print(tail)
        finally:
            io.open(path, 'w', encoding='utf8', newline='\n').write(original)
    run('npm run build')
    restored = run('node --test "tests/workflow-kernel/workshops/formalization/**/*.test.mjs" 2>&1')
    summary = [line for line in restored.stdout.splitlines() if line.startswith('# ') or 'pass ' in line or 'fail ' in line]
    print('=== restored (GREEN) ===')
    print('\n'.join(summary[-6:]))
    if failures:
        print('SURVIVED MUTATIONS: ' + ', '.join(failures))
        return 1
    print('ALL MUTATIONS KILLED')
    return 0


if __name__ == '__main__':
    sys.exit(main())
