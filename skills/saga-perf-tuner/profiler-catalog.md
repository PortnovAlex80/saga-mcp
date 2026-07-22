# Profiler catalog — Node/TS/V8 + system profilers

Reference file for `saga-perf-tuner`. Pick the profiler that matches the AC's
perf contract. **Measure before you emit any hint** (see "Measure-first loop" in
`SKILL.md`). Every command here is read-only evidence collection — it does not
mutate the worktree.

<!-- source: EXT-10 https://mcpmarket.com/tools/skills/performance-profiler-3
     (profiler command catalog: flame graphs, JFR, perf events; "when to use each")
     Adapted to our TS/Node stack. The original EXT-10 catalog covers Node, Python,
     Go and the JVM (JFR). We keep the JVM/JFR rows for completeness because some
     saga product repos run integration tests under Java tooling, but our default
     stack is Node/V8 (TypeScript), so Node commands are first-class. -->

## How to choose a profiler

| Symptom in the AC / build output | First profiler | Why |
|---|---|---|
| Bundle size over budget | `du` + `source-map-explorer` / build visualizer | Static; no runtime needed |
| Slow startup (cold start, first paint) | `node --cpu-prof` or `clinic doctor` | Samples the boot path |
| High steady-state CPU | `node --prof` or `0x` flame graph | Sampling CPU profiler |
| Memory growth / leak | `--heap-prof` or `clinic heapprofiler` | V8 heap snapshots over time |
| Event-loop stalls / latency spikes | `clinic doctor` + `--trace-event-categories` | Shows I/O, GC, and event-loop blocking |
| Native (C++) frames or kernel time | Linux `perf record` + `perf report` | Sees below V8 |
| JVM integration test tier | `async-profiler` / JFR | See JVM section below |

Pick **one** profiler per hypothesis. Running several at once perturbs the
measurement and invalidates the comparison (re-profile step below).

## Node / V8 built-in profilers (no install)

Our stack is TS-first; the dev worker's `npm run build` already produces Node
artifacts. These flags work on the built `dist/` entry point.

### CPU profile (`.cpuprofile` — open in Chrome DevTools → Performance)

```bash
node --cpu-prof --cpu-prof-dir=./perf-out --cpu-prof-name=tuner.cpuprofile dist/index.js
```

- **When:** slow startup, slow CLI, CPU-bound hot path in an AC.
- **Output:** `perf-out/tuner.cpuprofile` — a V8 sampling profile.
- **Read it:** drag into Chrome DevTools → Performance tab, or
  `npx speedscope perf-out/tuner.cpuprofile` for a flame graph.
- **Trade-off:** low overhead (~1-3%), good default.

### Tick profiler (V8 `--prof`, text report)

```bash
node --prof dist/index.js   # produces isolate-0xNNN-NN-v8.log
node --prof-process isolate-*-v8.log > prof-report.txt
```

- **When:** you want a quick ranked summary (JavaScript / C++ / GC %) without
  a GUI. Good for pasting numbers into a hint.
- **Output:** `prof-report.txt` with Lazy/Sharp compile, top hotspots by ticks.
- **Trade-off:** aggregate, not a flame graph. Symbols can be noisy for TS
  (mangled by build) — prefer `--cpu-prof` when you need call paths.

### Heap profiler (`.heapprofile` — allocation sampling)

```bash
node --heap-prof --heap-prof-dir=./perf-out dist/index.js
```

- **When:** AC says "memory ≤ X MB" or "no growth over N iterations".
- **Output:** `perf-out/Heap.*.heapprofile`.
- **Read it:** Chrome DevTools → Memory → Load, or `speedscope`.

### Heap snapshot (`.heapsnapshot` — full retention graph)

From inside the process (or a test driver):
```js
const v8 = require('node:v8');
const snap = v8.writeHeapSnapshot(); // writes Heap-<ts>.heapsnapshot to cwd
```

- **When:** you suspect a specific leak and need the retaining path (what is
  holding the object alive). Heavier than `--heap-prof`; use sparingly.
- **Read it:** Chrome DevTools → Memory → Heap snapshot.

### Trace events (`node --trace-event-categories`)

```bash
node --trace-event-categories=v8,node.async_hooks,v8.gc dist/index.js 2> trace.log
```

- **When:** event-loop stalls, GC pauses, async hook timing.
- **Output:** `trace_events-*.log` → load in `chrome://tracing` or Perfetto UI.
- **Note:** keep the category list narrow; full tracing floods the log.

## Clinic.js (when installed or addable as a dev-only consultation)

[`clinic.js`](https://clinicjs.org/) ships four tools that produce self-contained
HTML reports. Prefer these when you need a human-readable artifact to paste into
the hint.

```bash
npx clinic doctor -- node dist/index.js        # triage: picks the next tool
npx clinic flame -- node dist/index.js         # CPU flame graph (0x under the hood)
npx clinic bubbleprof -- node dist/index.js    # async operations
npx clinic heapprofiler -- node dist/index.js  # allocation flame graph
```

- **`clinic doctor`** is the entry point: it runs the app and recommends which of
  the other three to use. Good when you don't yet know whether the problem is
  CPU, I/O, or memory.
- **Output:** `.<tool>-<n>/` HTML report.
- **Caveat:** clinic is a dev-tool; if the worktree has no `clinic` dependency,
  note in the hint that the dev worker must `npm i -D clinic` before re-profiling.
  Do **not** add it to the specialist worktree's `package.json` — the specialist
  does not edit code or manifests.

## `0x` flame graph (focused CPU flame)

```bash
npx 0x --output-dir=./perf-out dist/index.js
```

- **When:** you want a single SVG flame graph of CPU time, fastest path to a
  visual. `clinic flame` wraps `0x`.
- **Output:** `perf-out/flamegraph.html`.

## Linux perf (system-level, native + kernel)

For Node apps with native addons (node-gyp, `better-sqlite3`, `sharp`, etc.) V8
profilers hide the C++ frames. `perf` sees them.

```bash
# Collect (run the workload for a representative window)
perf record -F 99 -p <pid> -g -- sleep 30

# Report (text tree)
perf report -g graph,0.5,callee --no-children

# Flame graph (needs brendangregg/FlameGraph scripts)
perf script | stackcollapse-perf.pl | flamegraph.pl > perf.svg
```

- **When:** CPU time is in native frames, or you need kernel/syscall time.
- **Prerequisite:** `perf_event_paranoid` ≤ 1, or run as root. If denied,
  fall back to `--cpu-prof` and note the limitation in the hint.
- **V8 symbol resolution:** run Node with `--perf-prof` (and on older V8,
  `--interpreted-frames-native-stack`) so JS functions show up with names.
  Without it, frames show as `v8::internal::*`.

## JVM / JFR (integration-test tier only)

<!-- source: EXT-10 — the original catalog's JFR rows. Kept for repos that run a
     JVM tier (e.g. an integration test container, or a sibling Java service).
     Our first-class stack is Node; this section is opt-in. -->

Most saga product repos are TS/Node and do **not** need this. Use it only when
the perf AC is about a JVM component (a Java service, an Android instrumented
test, a Gradle build step).

```bash
# Java Flight Recorder (low overhead, production-safe)
java -XX:StartFlightRecording=duration=60s,filename=app.jfr -jar app.jar

# Analyze
# - JDK Mission Control (JMC) GUI, or
java -jar jfr2flame.jar app.jfr > flame.html   # via async-profiler's jfr2flame
```

```bash
# async-profiler (samples native frames incl. JVM; avoids safepoint bias)
./profiler.sh -d 30 -f profile.html <pid>      # flame graph
./profiler.sh -d 30 -e alloc -f alloc.html <pid>   # allocation profile
```

- **JFR vs async-profiler:** JFR is built into the JDK and lowest-friction;
  async-profiler sees more (incl. off-JVM-heap) but needs a binary install.
- **When to use each:** default to JFR for a quick capture; reach for
  async-profiler when JFR's safepoint bias would hide the hot path (very short
  methods, JIT-compiled loops).

## Interpreting a flame graph (quick rules)

A flame graph reads bottom-up: the x-axis is the sample population (width =
relative time), the y-axis is the call stack (a frame sits on top of its caller).

1. **Wide towers at the top** = a single function is hot. Fix that function.
2. **Wide towers in the middle** = a subtree is hot. Optimize that call path.
3. **A frame that is almost all of the width near the root** = the program
   spends nearly all its time under that entry point; look one or two levels up.
4. **GC frames taking >5%** = allocation pressure; switch to the heap profiler.
5. **Idle / async gaps (clinic bubbleprof)** = waiting on I/O; not a CPU problem.

Never read a flame graph as "the tallest bar." Read it as "where is the sample
mass concentrated." A tall, narrow tower is a deep call stack, not necessarily
slow.

## Re-profile: comparing before/after

The measure-first loop (see `SKILL.md`) requires re-profiling after a proposed
change. To make the comparison valid:

- Use the **same** input/workload both times.
- Use the **same** profiler and flags.
- Capture a **baseline** profile *before* describing any fix, and an **after**
  profile once the dev worker applies the fix.
- Report both numbers in the hint's "Verification" section (e.g. "before 612KB /
  after 190KB gzip").

If the re-profile does **not** show the expected improvement, the hypothesis was
wrong — emit a revised hint rather than declaring success. The specialist never
self-authorizes a "pass"; the verifier records the `passed`/`unknown` verdict
(CGAD P14).

## Prerequisites checklist (run before any profiler)

- [ ] The triggering dev-task's worktree builds (`npm run build` succeeds). If
      not, emit the "fix build first" minimal hint and stop — profiling a broken
      build produces garbage.
- [ ] You are in the dev-task's worktree (`task.metadata.worktree.path`), not a
      stale checkout.
- [ ] Output directory (`./perf-out` or `./.<tool>-<n>/`) is gitignored or you
      will clean it up. The specialist does not commit profiling artifacts.
- [ ] You have a **perf budget** from the AC or PRD NFR. With no budget, the only
      valid hint is "no perf budget declared; nothing to tune" (see SKILL.md
      Anti-patterns).

## References

- Node.js profiling docs: <https://nodejs.org/en/learn/getting-started/profiling>
- V8 `--cpu-prof` / `--heap-prof` flags: `node --v8-options | grep -i prof`
- Clinic.js: <https://clinicjs.org/>
- `0x`: <https://github.com/davidmarkclements/0x>
- brendangregg FlameGraph: <https://github.com/brendangregg/FlameGraph>
- async-profiler: <https://github.com/async-profiler/async-profiler>
- JDK Mission Control: <https://www.oracle.com/java/technologies/jdk-mission-control.html>
