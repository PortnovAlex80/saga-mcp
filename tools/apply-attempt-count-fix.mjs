import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/process-modules/application/node-executors/production-cell-node-executor.ts';
const source = readFileSync(path, 'utf8');
const before = `  private attemptCount(ref: WorkplaceRef, role: 'author' | 'reviewer'): number {
    // Count sealed CandidateSets for this role as the primary attempt counter.
    // Each CandidateSet represents one completed gate-evaluated attempt.
    const sealedAttempts = this.opts.candidateSetRepo.listForWorkplace(ref)
      .filter(set => set.role === role).length;
    // CGAD P18 / crash recovery: a crashed execution that never sealed a
    // CandidateSet still counts as an attempt. The Workplace's revision
    // reflects the number of transitions, which includes crash → repair_wait
    // cycles. When there are NO sealed CandidateSets but the workplace has
    // been through repair_wait, use the durable execution history to count
    // failed attempts. This prevents infinite crash loops where the worker
    // crashes before sealing, attemptCount stays 0, and maxAttempts is never
    // reached.
    // We use the higher of sealed attempts and the execution count from the
    // workplace's lifecycle events (stored in worker_executions).
    const state = this.opts.coordinator.readState(ref);
    if (state && sealedAttempts === 0 && state.loopState === 'repair_wait') {
      // Count terminal (failed/lost) executions for this workplace's task.
      // The task's workplace_ref identifies all executions that attempted work.
      const taskRow = this.opts.persistence.readTaskForWorkplace?.(ref);
      if (taskRow) {
        const failedExecs = this.opts.persistence.countTerminalExecutionsForTask?.(taskRow.taskId) ?? 0;
        return Math.max(sealedAttempts, failedExecs);
      }
    }
    return sealedAttempts;
  }`;
const after = `  private attemptCount(ref: WorkplaceRef, role: 'author' | 'reviewer'): number {
    // One role attempt ends either by sealing a CandidateSet or by terminating
    // before a seal (lost/terminated/spawn_failed). Both consume the same
    // bounded recovery budget. A crash after the first successful candidate
    // must not become invisible, otherwise a repair worker can crash forever.
    const sealedAttempts = this.opts.candidateSetRepo.listForWorkplace(ref)
      .filter(set => set.role === role).length;
    const roleTask = this.opts.persistence.readProjectedRoleTask?.(ref, role)
      ?? (sealedAttempts === 0
        ? this.opts.persistence.readTaskForWorkplace?.(ref) ?? null
        : null);
    const failedExecutions = roleTask
      ? this.opts.persistence.countTerminalExecutionsForTask?.(roleTask.taskId) ?? 0
      : 0;
    return sealedAttempts + failedExecutions;
  }`;

if (!source.includes(before)) {
  if (source.includes(after)) {
    console.log('attempt-count fix already applied');
    process.exit(0);
  }
  throw new Error('attemptCount patch anchor not found');
}
writeFileSync(path, source.replace(before, after), 'utf8');
console.log('attempt-count fix applied');
