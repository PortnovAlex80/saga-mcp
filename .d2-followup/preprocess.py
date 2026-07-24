from pathlib import Path

path = Path('.d2-followup/apply.py')
text = path.read_text(encoding='utf-8')
old = '''replace_once(
    'src/app/composition-root.ts',
    "      workerExecutorFactory,\\n      persistence,\\n      host,\\n      runtimePersistence,\\n",
    "      workerExecutorFactory,\\n      host,\\n      runtimePersistence,\\n",
)
'''
new = '''replace_once(
    'src/app/composition-root.ts',
    "    const normalizationService = new Saga3DiscoveryNormalizationService({\\n      config,\\n      workerExecutorFactory,\\n      persistence,\\n      host,\\n      runtimePersistence,\\n    });",
    "    const normalizationService = new Saga3DiscoveryNormalizationService({\\n      config,\\n      workerExecutorFactory,\\n      host,\\n      runtimePersistence,\\n    });",
)
'''
if text.count(old) != 1:
    raise SystemExit(f'apply.py composition block count={text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
