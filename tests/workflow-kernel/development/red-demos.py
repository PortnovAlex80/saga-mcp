"""WP-08 RED demonstration patcher: applies ONE deliberate source mutation,
runs the pinned suite, and restores. Never leaves a mutation behind."""
import io
import subprocess
import sys

MUTATIONS = {
    'capsule-digest-fence': {
        'file': 'src/workflow-kernel/development/capsule.ts',
        'old': "if (sha256OfCanonical(factBody) !== capsule.capsuleDigest || capsule.capsuleRef !== `sha256:${capsule.capsuleDigest}`) {\n    return refused('BYTES_CORRUPT', 'the capsule self-address does not verify against its canonical facts (corrupt capsule bytes)');\n  }",
        'new': "/* MUTATION: capsule digest fence disabled */ if (false) { return undefined; }",
        'suite': 'tests/workflow-kernel/development/capsule-ingress.test.mjs',
    },
    'actor-skip-ingress': {
        'file': 'src/workflow-kernel/development/actors.ts',
        'old': "  const send = await transport.sendProviderRequest({\n    attemptRef: launch.attemptRef,\n    expectedContextRevision: launch.expectedContextRevision + stepIndex,\n    envelope,\n    idempotencyKey: `${launch.idempotencyKeyPrefix}#req-${stepIndex + 1}`,\n  });",
        'new': "  /* MUTATION: actor skips ingress and fabricates a delivered result */\n  const fabricatedReceipt = { decision: 'admitted', requestOrdinal: 1, digest: 'fabricated', receiptRef: 'sha256:fabricated' };\n  const send = { kind: 'delivered', receipt: fabricatedReceipt, obligation: { kind: 'obligation:providerSend', idempotencyKey: 'fabricated' }, outcomeDigest: 'sha256:fabricated' };",
        'suite': 'tests/workflow-kernel/development/material-chain.test.mjs',
    },
    'role-reresolve': {
        'file': 'src/workflow-kernel/development/role-contract-runtime.ts',
        'old': "  resolveOnce(launchKind: string): RoleResolution {\n    const cached = this.slots.get(launchKind);\n    if (cached !== undefined) {\n      return { resolved: true, slot: cached };\n    }",
        'new': "  resolveOnce(launchKind: string): RoleResolution {\n    const cached = this.slots.get(launchKind);\n    if (false) {\n      return { resolved: true, slot: cached };\n    }",
        'suite': 'tests/workflow-kernel/development/role-contract.test.mjs',
    },
    'acceptance-surface-fence': {
        'file': 'src/workflow-kernel/development/product-acceptance.ts',
        'old': "  return surfaces.filter((surface) => !existsSync(join(root, surface)));",
        'new': "  /* MUTATION: missing surfaces silently pass */ return [];",
        'suite': 'tests/workflow-kernel/development/acceptance.test.mjs',
    },
}


def run(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='replace')


def main():
    name = sys.argv[1]
    mutation = MUTATIONS[name]
    path = mutation['file']
    original = io.open(path, encoding='utf8').read()
    if mutation['old'] not in original:
        print(f'PATTERN NOT FOUND for {name}')
        return 2
    mutated = original.replace(mutation['old'], mutation['new'])
    io.open(path, 'w', encoding='utf8', newline='\n').write(mutated)
    try:
        run('npm run build')
        result = run(f'node --test "{mutation["suite"]}" 2>&1')
        tail = '\n'.join(result.stdout.strip().splitlines()[-8:])
        print(f'=== RED {name} (mutated) ===')
        print(tail)
    finally:
        io.open(path, 'w', encoding='utf8', newline='\n').write(original)
        run('npm run build')
        result = run(f'node --test "{mutation["suite"]}" 2>&1')
        summary = [line for line in result.stdout.splitlines() if 'pass ' in line or 'fail ' in line]
        print(f'=== {name} restored ===')
        print('\n'.join(summary))
    return 0


if __name__ == '__main__':
    sys.exit(main())
