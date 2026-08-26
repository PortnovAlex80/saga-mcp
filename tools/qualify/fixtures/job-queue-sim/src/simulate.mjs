/**
 * job-queue-sim/src/simulate.mjs - the in-memory job-queue simulator (plan
 * EK-11 P10): a deterministic discrete-event simulation of a bounded worker
 * pool draining a job queue (arrival, dequeue, complete, retry on failure).
 * No wall clock, no randomness beyond the frozen LCG seed - two runs are
 * byte-identical.
 */

/** One deterministic simulation; returns the final report document. */
export function simulate({ jobCount = 24, workers = 2, queueCap = 4, seed = 20260825 } = {}) {
  let state = seed % 2147483647;
  const next = () => { state = (state * 48271) % 2147483647; return state; };
  const queue = [];
  const done = [];
  const events = [];
  let clock = 0;
  let produced = 0;
  let retries = 0;
  const busy = new Array(workers).fill(false);
  const progress = new Array(workers).fill(0);
  let peakQueue = 0;
  let peakBusy = 0;
  while (done.length < jobCount) {
    clock += 1;
    /* one arrival per tick while production lasts (bounded queue: arrivals
       block - the tick counts, the job waits). */
    if (produced < jobCount) {
      if (queue.length < queueCap) {
        produced += 1;
        queue.push({ id: produced, attempts: 0 });
        peakQueue = Math.max(peakQueue, queue.length);
        events.push(`t${clock}:arrive:${produced}`);
      } else {
        events.push(`t${clock}:blocked`);
      }
    }
    /* idle workers dequeue. */
    for (let worker = 0; worker < workers; worker += 1) {
      if (!busy[worker] && queue.length > 0) {
        const job = queue.shift();
        job.attempts += 1;
        busy[worker] = true;
        progress[worker] = { job, remaining: 1 + (next() % 3) };
        events.push(`t${clock}:dequeue:w${worker}:${job.id}`);
      }
    }
    peakBusy = Math.max(peakBusy, busy.filter((isBusy) => isBusy).length);
    /* busy workers progress; completion fails deterministically ~1/7 (retry). */
    for (let worker = 0; worker < workers; worker += 1) {
      if (!busy[worker]) continue;
      progress[worker].remaining -= 1;
      if (progress[worker].remaining > 0) continue;
      const job = progress[worker].job;
      busy[worker] = false;
      const failed = next() % 7 === 0 && job.attempts < 3;
      if (failed) {
        retries += 1;
        queue.push(job);
        events.push(`t${clock}:retry:w${worker}:${job.id}`);
      } else {
        done.push({ id: job.id, attempts: job.attempts, worker });
        events.push(`t${clock}:done:w${worker}:${job.id}`);
      }
    }
    if (clock > jobCount * 50) throw new Error('simulation failed to converge');
  }
  return {
    kind: 'job-queue-sim.report.v1',
    config: { jobCount, workers, queueCap, seed },
    ticks: clock,
    completed: done.length,
    retries,
    peakQueueLength: peakQueue,
    peakBusyWorkers: peakBusy,
    perWorkerCompleted: Array.from({ length: workers }, (_, worker) => done.filter((job) => job.worker === worker).length),
  };
}

const isMain = process.argv[1] !== undefined
  && (await import('node:path')).resolve(process.argv[1]) === (await import('node:url')).fileURLToPath(import.meta.url);
if (isMain) {
  process.stdout.write(`${JSON.stringify(simulate(), null, 2)}\n`);
}
