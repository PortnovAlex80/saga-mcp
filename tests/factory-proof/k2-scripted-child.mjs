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

import { readFileSync } from 'node:fs';
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

  const program = JSON.parse(readFileSync(programPath, 'utf8'));
  const prompt = await readStdin(process.stdin);
  const taskIdMatch = new RegExp(program.taskIdPattern).exec(prompt);
  if (!taskIdMatch) {
    process.stderr.write('k2-child: task id not present in the prompt (production-visible input)\n');
    process.exit(3);
  }

  const mcp = connectMcpServer(JSON.parse(readFileSync(mcpConfigPath, 'utf8')));
  try {
    await mcp.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'k2-scripted-child', version: '1.0.0' },
    });
    mcp.notify('notifications/initialized');

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
