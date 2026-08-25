"""WP-11L RED demonstration patcher: applies ONE deliberate source mutation
per fence family, runs the pinned suite, and restores. Never leaves a
mutation behind.

Fence families (one RED demo each):
  bundle-foreign-lineage-fence    ingress fence    (bundle.ts)
  preflight-undeclared-fence      gate fence       (preflight.ts)
  packaging-already-applied-fence idempotence fence (packaging.ts)
  approval-immutability-fence     approval fence   (approval.ts)
  duplicate-release-fence         record fence     (packaging.ts)
"""
import io
import subprocess
import sys

MUTATIONS = {
    'bundle-foreign-lineage-fence': {
        'file': 'src/workflow-kernel/workshops/delivery/bundle.ts',
        'old': "  if (bundle.lineage.lineageId !== binding.expectedLineageId) {\n    return refused('FOREIGN_LINEAGE', `bundle lineage ${bundle.lineage.lineageId} is not the bound lineage ${binding.expectedLineageId}; a foreign bundle never enters this database`);\n  }",
        'new': "  /* MUTATION: foreign-lineage fence disabled */ if (false) { return refused('FOREIGN_LINEAGE', 'unreachable'); }",
        'suite': 'tests/workflow-kernel/workshops/delivery/bundle.test.mjs',
    },
    'preflight-undeclared-fence': {
        'file': 'src/workflow-kernel/workshops/delivery/preflight.ts',
        'old': "  const undeclared = policy.requiredCheckIds.filter((checkId) => !isDeclaredCheck(checkId));\n  if (undeclared.length > 0) {",
        'new': "  const undeclared = policy.requiredCheckIds.filter((checkId) => !isDeclaredCheck(checkId));\n  /* MUTATION: undeclared checks silently pass */ if (false) {",
        'suite': 'tests/workflow-kernel/workshops/delivery/preflight.test.mjs',
    },
    'packaging-already-applied-fence': {
        'file': 'src/workflow-kernel/workshops/delivery/packaging.ts',
        'old': "  // Idempotent re-drive: the artifact already exists for THIS candidate.\n  if (existsSync(manifest)) {",
        'new': "  // Idempotent re-drive: the artifact already exists for THIS candidate.\n  /* MUTATION: duplicate re-package never observes the existing artifact */ if (false) {",
        'suite': 'tests/workflow-kernel/workshops/delivery/packaging.test.mjs',
    },
    'approval-immutability-fence': {
        'file': 'src/workflow-kernel/workshops/delivery/approval.ts',
        'old': "    if (existing.decisionDigest !== decisionDigest) {\n      return {\n        refused: true,\n        reason: 'APPROVAL_DECISION_IMMUTABLE',",
        'new': "    /* MUTATION: decision re-write allowed */ if (false) {\n      return {\n        refused: true,\n        reason: 'APPROVAL_DECISION_IMMUTABLE',",
        'suite': 'tests/workflow-kernel/workshops/delivery/approval.test.mjs',
    },
    'duplicate-release-fence': {
        'file': 'src/workflow-kernel/workshops/delivery/packaging.ts',
        'old': "    const existing = JSON.parse(readFileSync(path, 'utf8')) as ReleaseRecord;\n    if (existing.recordDigest === recordDigest) {\n      return { replayed: true, record: existing };\n    }",
        'new': "    const existing = JSON.parse(readFileSync(path, 'utf8')) as ReleaseRecord;\n    /* MUTATION: any second record replays */ if (true) {\n      return { replayed: true, record: existing };\n    }",
        'suite': 'tests/workflow-kernel/workshops/delivery/packaging.test.mjs',
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
