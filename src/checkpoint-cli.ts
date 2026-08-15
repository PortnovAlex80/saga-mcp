#!/usr/bin/env node
import path from 'node:path';
import { FactoryCheckpointService } from './checkpoints/factory-checkpoint-service.js';

function values(argv: readonly string[]): { command: string; flags: Map<string, string | true> } {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (const token of rest) {
    if (!token.startsWith('--')) throw new Error(`unexpected argument '${token}'`);
    const separator = token.indexOf('=');
    if (separator === -1) flags.set(token.slice(2), true);
    else flags.set(token.slice(2, separator), token.slice(separator + 1));
  }
  return { command, flags };
}

function required(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name}=... is required`);
  return value.trim();
}

function numberFlag(flags: Map<string, string | true>, name: string, nullable = false): number | null {
  const raw = flags.get(name);
  if (nullable && raw === undefined) return null;
  if (typeof raw !== 'string' || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new Error(`--${name}=<positive integer> is required`);
  }
  return Number(raw);
}

function dbPath(flags: Map<string, string | true>): string {
  const value = flags.get('db') ?? process.env.DB_PATH;
  if (typeof value !== 'string' || !value) throw new Error('--db=... or DB_PATH is required');
  return path.resolve(value);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  saga-checkpoint capture --db=... --store=... --project=ID [--epic=ID] [--actor=NAME] [--include-logs]
  saga-checkpoint verify --manifest=... [--hmac-key=...]
  saga-checkpoint warm-start-fixture --manifest=... [--hmac-key=...]
  saga-checkpoint restore-clone --manifest=... --target-db=... --target-workspace=...
  saga-checkpoint adopt --db=... --manifest=... --project=ID --epic=ID --process-run=ID --node=ID --source-node-run=ID --actor=NAME --reason=TEXT [--trust-local] [--profile=full|test_replay]

Set SAGA_CHECKPOINT_HMAC_KEY instead of passing --hmac-key on shared shells.
Raw worker logs are excluded by default because they can contain secrets.
`);
}

async function main(): Promise<void> {
  const { command, flags } = values(process.argv.slice(2));
  const service = new FactoryCheckpointService();
  const keyFlag = flags.get('hmac-key');
  const hmacKey = typeof keyFlag === 'string' ? keyFlag : process.env.SAGA_CHECKPOINT_HMAC_KEY;
  if (command === 'capture') {
    const manifest = await service.capture({
      dbPath: dbPath(flags), storageRoot: path.resolve(required(flags, 'store')),
      projectId: numberFlag(flags, 'project')!, epicId: numberFlag(flags, 'epic', true),
      createdBy: typeof flags.get('actor') === 'string' ? String(flags.get('actor')) : 'checkpoint-cli',
      includeLogs: flags.get('include-logs') === true,
      ...(hmacKey ? { hmacKey, signatureKeyId: 'env:SAGA_CHECKPOINT_HMAC_KEY' } : {}),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, checkpoint: manifest.payload.checkpointRef, digest: manifest.digest })}\n`);
    return;
  }
  if (command === 'verify') {
    const manifest = service.verify(path.resolve(required(flags, 'manifest')), hmacKey);
    process.stdout.write(`${JSON.stringify({ ok: true, checkpoint: manifest.payload.checkpointRef, digest: manifest.digest })}\n`);
    return;
  }
  if (command === 'warm-start-fixture') {
    const manifest = service.verify(path.resolve(required(flags, 'manifest')), hmacKey);
    process.stdout.write(`${JSON.stringify(service.createWarmStartFixture(manifest), null, 2)}\n`);
    return;
  }
  if (command === 'restore-clone') {
    service.restoreClone({
      manifestPath: path.resolve(required(flags, 'manifest')),
      targetDbPath: path.resolve(required(flags, 'target-db')),
      targetWorkspace: path.resolve(required(flags, 'target-workspace')),
      hmacKey,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, restored: true })}\n`);
    return;
  }
  if (command === 'adopt') {
    const profileFlag = flags.get('profile');
    const verificationProfile = profileFlag === undefined ? 'full' : String(profileFlag);
    if (verificationProfile !== 'full' && verificationProfile !== 'test_replay') {
      throw new Error('--profile must be full or test_replay');
    }
    const result = service.adopt({
      dbPath: dbPath(flags), manifestPath: path.resolve(required(flags, 'manifest')),
      targetProjectId: numberFlag(flags, 'project')!,
      targetEpicId: numberFlag(flags, 'epic', true),
      targetProcessRunId: numberFlag(flags, 'process-run')!,
      targetNodeId: required(flags, 'node'), sourceNodeRunId: numberFlag(flags, 'source-node-run')!,
      actor: required(flags, 'actor'), reason: required(flags, 'reason'), hmacKey,
      trustLocalRegistry: flags.get('trust-local') === true,
      verificationProfile,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  printHelp();
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
