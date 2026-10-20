// What does a bigger context cost in memory, and what does a second user cost in waiting time?
//
// Usage (Git Bash):  node context-test.mjs [runs] [model]
//   default runs: 3 (for the waiting-time part); default model: llama3.2:3b
//
// The script starts its OWN Ollama server on 127.0.0.1:11500 for each configuration, with the
// settings under test as environment variables, and stops it afterwards. Your normal Ollama on
// 11434 is not touched (it only needs to have no model loaded, so both do not fight for memory).
// The server log of each configuration is saved next to the results: it shows the exact command
// Ollama gives its engine (-c = context, -np = parallel slots, --cache-type-k/v = KV cache type)
// and the engine's own memory breakdown (model + context + compute, in MiB).
//
// Part 1, memory: load the model with num_ctx 2048 to 32768, KV cache f16 then q8_0, and read
// the memory used (`/api/ps` size and the engine breakdown). No answer is generated.
// Part 2, waiting time: OLLAMA_NUM_PARALLEL=1 then 2, num_ctx 8192. Send 1, 2, 3, then 4 requests
// at the same second; each one asks for a report on 6 client notes, cut at 200 tokens. For every request:
// time to the first word (the wait) and time to the last word.
// Results: printed summary + results/<timestamp>.json (+ one .log per server configuration).

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = Number(process.argv[2] ?? 3);
const MODEL = process.argv[3] ?? 'llama3.2:3b';
const MAIN_HOST = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const PORT = 11500;
const HOST = `http://127.0.0.1:${PORT}`;
const CONTEXTS = [2048, 4096, 8192, 16384, 32768];
const PARALLEL_CTX = 8192;
const ANSWER_TOKENS = 200;
const MAX_USERS = 4;

const here = path.dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(here, 'results');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${stamp}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (host, route, body) => {
  const res = await fetch(`${host}${route}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`${route}: Ollama answered ${res.status}: ${await res.text()}`);
  return res.json();
};

// --- Own server per configuration ---------------------------------------------------------
let server = null;
let logPath = null;
const startServer = async (name, env) => {
  logPath = path.join(outDir, `${stamp}-${name}.log`);
  const log = createWriteStream(logPath);
  server = spawn('ollama', ['serve'], {
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${PORT}`, OLLAMA_KEEP_ALIVE: '10m', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  for (let i = 0; i < 60; i++) {
    try { await api(HOST, '/api/version'); return; } catch { await sleep(500); }
  }
  throw new Error(`the test server did not start, see ${logPath}`);
};
const stopServer = async () => {
  if (!server) return;
  try { await api(HOST, '/api/generate', { model: MODEL, keep_alive: 0 }); } catch { /* already gone */ }
  // Windows: kill the whole tree, or the engine process can outlive the server.
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* exited */ }
  } else server.kill();
  server = null;
  await sleep(1500);
  // The logs are published: replace the home folder (it contains the user name) with ~.
  const home = os.homedir();
  const text = readFileSync(logPath, 'utf8');
  writeFileSync(logPath, text.split(home).join('~').split(home.replaceAll('\\', '\\\\')).join('~'));
};
process.on('SIGINT', async () => { await stopServer(); process.exit(130); });

// The last engine start in the log: its command line and its memory breakdown.
const readEngine = () => {
  const text = readFileSync(logPath, 'utf8');
  const last = text.split('msg="starting llama-server"').at(-1);
  const arg = (flag) => last.match(new RegExp(`${flag} (\\S+)`))?.[1];
  const mem = [...last.matchAll(/- Host\s*\|\s*(\d+)\s*=\s*(\d+)\s*\+\s*(\d+)\s*\+\s*(\d+)/g)].at(-1);
  return {
    engineCtx: Number(arg('-c')), slots: Number(arg('-np')), kvType: arg('--cache-type-k') ?? 'f16',
    breakdownMiB: mem ? { total: +mem[1], model: +mem[2], context: +mem[3], compute: +mem[4] } : null,
  };
};
const loadedSize = async () => {
  const ps = await api(HOST, '/api/ps');
  const m = ps.models.find((x) => x.name === MODEL);
  return m ? { sizeGB: +(m.size / 1e9).toFixed(2), contextLength: m.context_length } : null;
};

// --- The prompt for part 2: 6 short client notes, a unique first line per request ----------
const notes = [
  'Client 004 complained that the delivery arrived nine days after the promised date.',
  'Client 017 asked for a copy of last quarter invoice and the payment terms.',
  'Client 023 is unhappy because the shipment was late again this month.',
  'Client 031 wants to add two users to the support contract next month.',
  'Client 046 reported that the new dashboard is easier to read than the old one.',
  'Client 058 says the order was delivered late and the site team lost a full day.',
];
const promptFor = (id) =>
  `Request ${id}.\nHere are six client notes:\n${notes.join('\n')}\n\n` +
  // Asks for more than ANSWER_TOKENS, so every answer is cut at the same length and the
  // waiting times compare like with like.
  'Write a detailed report of at least 400 words for the account manager: every complaint, ' +
  'which clients, the likely cause, and three actions.';

// One streamed request: time to first token (the wait) and to the last token.
const ask = async (id, numCtx) => {
  const t0 = performance.now();
  const res = await fetch(`${HOST}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, prompt: promptFor(id), stream: true,
      options: { num_ctx: numCtx, num_predict: ANSWER_TOKENS, seed: id },
    }),
  });
  if (!res.ok) throw new Error(`request ${id}: Ollama answered ${res.status}: ${await res.text()}`);
  let first = null, final = null, buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (first === null && msg.response) first = performance.now();
      if (msg.done) final = msg;
    }
  }
  const end = performance.now();
  return {
    firstTokenS: +((first - t0) / 1000).toFixed(1), totalS: +((end - t0) / 1000).toFixed(1),
    tokens: final?.eval_count, promptTokens: final?.prompt_eval_count,
  };
};

// --- Run --------------------------------------------------------------------------------------
const results = {
  model: MODEL, runs: RUNS, answerTokens: ANSWER_TOKENS, parallelCtx: PARALLEL_CTX,
  machine: { cpu: os.cpus()[0]?.model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), platform: `${os.platform()} ${os.release()}` },
  ollama: null, memory: [], waiting: [],
};
const save = () => writeFileSync(file, JSON.stringify(results, null, 2));

try {
  const busy = (await api(MAIN_HOST, '/api/ps')).models;
  if (busy.length) console.warn(`Warning: your Ollama on ${MAIN_HOST} has ${busy.map((m) => m.name).join(', ')} loaded; run "ollama stop <model>" first for clean memory figures.`);
} catch { /* main Ollama not running: fine */ }

try {
  // Part 1: memory
  for (const kv of ['f16', 'q8_0']) {
    await startServer(`memory-${kv}`, kv === 'f16' ? {} : { OLLAMA_KV_CACHE_TYPE: kv, OLLAMA_FLASH_ATTENTION: '1' });
    results.ollama ??= (await api(HOST, '/api/version')).version;
    for (const numCtx of CONTEXTS) {
      await api(HOST, '/api/generate', { model: MODEL, prompt: 'hi', options: { num_ctx: numCtx, num_predict: 1 }, stream: false });
      await sleep(500);
      const row = { kv, numCtx, ...(await loadedSize()), ...readEngine() };
      results.memory.push(row); save();
      console.log(`memory  kv ${kv.padEnd(4)} num_ctx ${String(numCtx).padStart(5)}: ${row.sizeGB} GB` +
        (row.breakdownMiB ? ` (model ${row.breakdownMiB.model} + context ${row.breakdownMiB.context} + compute ${row.breakdownMiB.compute} MiB)` : ''));
      await api(HOST, '/api/generate', { model: MODEL, keep_alive: 0 });
      await sleep(1000);
    }
    await stopServer();
  }

  // Part 2: waiting time with 1 to 4 users at once
  let nextId = 1;
  for (const parallel of [1, 2]) {
    await startServer(`parallel-${parallel}`, { OLLAMA_NUM_PARALLEL: String(parallel) });
    await ask(nextId++, PARALLEL_CTX); // load the model first: loading time is not waiting time
    const loaded = { ...(await loadedSize()), ...readEngine() };
    console.log(`\nNUM_PARALLEL=${parallel}: ${loaded.sizeGB} GB loaded, engine context ${loaded.engineCtx} (${loaded.slots} slot(s))`);
    for (let run = 1; run <= RUNS; run++) {
      for (let users = 1; users <= MAX_USERS; users++) {
        const ids = Array.from({ length: users }, () => nextId++);
        const answers = await Promise.all(ids.map((id) => ask(id, PARALLEL_CTX)));
        const waits = answers.map((a) => a.firstTokenS).sort((a, b) => a - b);
        const totals = answers.map((a) => a.totalS).sort((a, b) => a - b);
        results.waiting.push({ parallel, run, users, loaded, answers });
        save();
        const short = answers.filter((a) => a.tokens < ANSWER_TOKENS).length;
        console.log(`  run ${run}, ${users} user(s): first word after ${waits.join(' / ')} s; done after ${totals.join(' / ')} s` +
          (short ? ` (${short} answer(s) shorter than ${ANSWER_TOKENS} tokens)` : ''));
      }
    }
    await stopServer();
  }
} finally {
  await stopServer();
  save();
}
console.log(`\nSaved ${file}`);
