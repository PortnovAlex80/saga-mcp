#!/usr/bin/env node
// tests/factory-proof/k2-scripted-child.mjs
//
// K2-A — the STRICT spawned actor (ADR-084 / conformance-engine plan §K2).
//
// A deterministic child process that is argv-compatible with the worker CLI
// the production runner spawns: it receives the SAME envelope (argv flags,
// stdin prompt, cwd, sanitized env, per-execution --mcp-config) and replaces
// ONLY model cognition. It NEVER touches SQLite, repositories, finalizers or
// transition handlers directly — every durable effect goes through the REAL
// saga MCP server configured by the production runner (the exact
// `node <sagaEntry>` stdio server with the per-execution identity env).
//
// Program input is strictly production-visible (W0-3 non-omniscience):
//   - the stdin prompt (task id via a declared pattern),
//   - results of its OWN previous MCP tool calls,
// and NOTHING else: no attempt counters, no scenario ids, no DB reads.
//
// Exit contract (mirrors CLI classification the runner already owns):
//   0 — every step succeeded (tools/call not isError)
//   3 — envelope parsing failed (no task id in prompt / no --mcp-config)
//   4 — a tool call failed (the runner classifies the exit; repair feedback
//        arrives through the next prompt — the W1-1 causal loop)

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Minimal MCP stdio client: ndjson JSON-RPC over the server's stdio.
function connectMcpServer(config) {
  const server = config.mcpServers?.saga;
  if (!server) throw new Error('k2-child: --mcp-config has no mcpServers.saga');
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  let nextId = 1;
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* non-JSON noise on stdout is ignored */ }
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`k2-child: MCP ${method} timed out`));
      }
    }, 60_000).unref();
  });
  const notify = method => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { child, request, notify };
}

function toolPayload(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text === 'string') {
    try { return JSON.parse(text); } catch { return text; }
  }
  return result;
}

async function main() {
  const mcpConfigPath = argValue(process.argv, '--mcp-config');
  const programPath = process.env.K2_ACTOR_PROGRAM;
  if (!mcpConfigPath) { process.stderr.write('k2-child: no --mcp-config in envelope\n'); process.exit(3); }
  if (!programPath) { process.stderr.write('k2-child: K2_ACTOR_PROGRAM env missing\n'); process.exit(3); }

  const isModuleProgram = programPath.endsWith('.mjs');
  const program = isModuleProgram
    ? null
    : JSON.parse(readFileSync(programPath, 'utf8'));
  const prompt = await readStdin(process.stdin);
  const taskIdMatch = new RegExp(
    isModuleProgram ? 'task[_ ]?id[^0-9]*(\\d+)' : program.taskIdPattern,
  ).exec(prompt);
  if (!taskIdMatch) {
    process.stderr.write('k2-child: task id not present in the prompt (production-visible input)\n');
    process.exit(3);
  }

  if (process.env.K2_PROMPT_DUMP) {
    try {
      mkdirSync(process.env.K2_PROMPT_DUMP, { recursive: true });
      writeFileSync(path.join(process.env.K2_PROMPT_DUMP, `prompt-${process.pid}.txt`), prompt, 'utf8');
    } catch { /* debug dump only */ }
  }

  const mcp = connectMcpServer(JSON.parse(readFileSync(mcpConfigPath, 'utf8')));
  try {
    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'k2-scripted-child', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized');

    // K2-B: an .mjs program module is the full actor (cell dispatch from the
    // production-visible task metadata, repair branches on typed feedback).
    // The toolkit below is the actor's ONLY interface to the world: MCP tool
    // calls, writes INSIDE the pinned cwd, hashes of its own files, the raw
    // prompt. No DB, no attempt counters, no scenario state.
    if (programPath.endsWith('.mjs')) {
      const callTool = async (tool, args) => {
        const response = await mcp.request('tools/call', { name: tool, arguments: args });
        const isError = Boolean(response.error || response.result?.isError);
        const payload = toolPayload(response.result ?? response);
        if (isError) {
          const detail = response.error?.message
            ?? response.result?.content?.[0]?.text
            ?? 'unknown tool failure';
          throw new Error(String(detail));
        }
        return payload;
      };
      const firstTask = await callTool('task_get', { id: Number(taskIdMatch[1]) });
      const root = process.cwd();
      const contained = rel => {
        const full = path.resolve(root, rel);
        if (!full.startsWith(root + path.sep) && full !== root) {
          throw new Error(`k2-child: write outside the pinned workspace: ${rel}`);
        }
        return full;
      };
      const mod = await import(pathToFileURL(path.resolve(programPath)).href
        + `?v=${Date.now()}`);
      await mod.run({
        prompt,
        taskId: Number(taskIdMatch[1]),
        firstTask,
        call: callTool,
        write: (rel, content) => {
          const full = contained(rel);
          mkdirSync(path.dirname(full), { recursive: true });
          writeFileSync(full, content, 'utf8');
        },
        fileHash: rel => createHash('sha256').update(readFileSync(contained(rel))).digest('hex'),
        progress: line => process.stdout.write(`${JSON.stringify({ type: 'step', tool: String(line).slice(0, 80) })}
`),
        // Evidence rail (never authority): the actor's own account of what it
        // SAW — e.g. the typed rejection of a fabricated first attempt.
        witness: text => process.stderr.write(`k2-witness ${String(text).slice(0, 400)}
`),
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      mcp.child.kill();
      process.exit(0);
    }

    let firstTaskGet = null;
    for (const step of program.steps) {
      const resolve = (value) => {
        if (value === '$taskId') return Number(taskIdMatch[1]);
        if (value === '$executionId') return firstTaskGet?.current_execution_id ?? null;
        if (value === '$workerId') return firstTaskGet?.assigned_to ?? null;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
        }
        return value;
      };
      const response = await mcp.request('tools/call', {
        name: step.tool,
        arguments: resolve(step.args),
      });
      if (step.tool === 'task_get' && !firstTaskGet) firstTaskGet = toolPayload(response.result);
      // stream-json-ish progress: the runner's progress_at heartbeat sees stdout.
      process.stdout.write(`${JSON.stringify({ type: 'step', tool: step.tool, isError: Boolean(response.error || response.result?.isError) })}\n`);
      if (response.error || response.result?.isError) {
        const detail = response.error?.message
          ?? response.result?.content?.[0]?.text
          ?? 'unknown tool failure';
        process.stderr.write(`k2-child: tool ${step.tool} failed: ${detail}\n`);
        process.exit(4);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    mcp.child.kill();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`k2-child: ${error?.message ?? error}\n`);
    mcp.child.kill();
    process.exit(4);
  }
}

main();
