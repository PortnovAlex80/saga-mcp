// tests/fixtures/engine-spawn-stub.mjs
//
// Stand-in for dist/orchestrate-cli.js in the E-P1 spawn-contract test
// (tests/app/factory-engine-spawn.test.mjs). It proves the REAL stdio wiring
// of scripts/factory-engine-spawn.mjs: spawned detached with stdout/stderr as
// file descriptors, the child's output must land in the engine log file while
// the child is still alive (the parent does not wait for it).
//
// The heartbeat/phase markers of a real engine come from
// $SAGA_ENGINE_LOG via src/runtime/engine-file-logger.ts; the stub mimics the
// observable part only (a stdout line + a 10s idle window).

process.stdout.write(`ENGINE-STUB-STDOUT launch-ref=${process.argv[2] ?? 'none'}\n`);
process.stderr.write(`ENGINE-STUB-STDERR engine-log=${process.env.SAGA_ENGINE_LOG ?? 'unset'}\n`);

// Stay alive long enough for the test to observe the log content; exit by
// itself so a missed cleanup never leaks the process.
setTimeout(() => {
  process.stdout.write('ENGINE-STUB-EXIT\n');
  process.exit(0);
}, 10_000).unref?.();
