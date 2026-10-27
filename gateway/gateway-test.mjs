// Does a token gate in front of Ollama hold, and what does it cost?
// Starts Caddy (docker compose) in front of the local Ollama, then checks: no token and wrong token
// are refused, each person's token works, a token can be revoked without a restart, the logs name
// the person but never show the token, the added delay, and whether streaming still streams.
//
// Usage: node gateway-test.mjs [model]      (default llama3.2:1b)
// Needs: Docker running, Ollama on http://localhost:11434 with the model pulled. Node 18+.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.argv[2] ?? 'llama3.2:1b';
const DIRECT = 'http://localhost:11434';
const GATE = 'http://127.0.0.1:8088';
const USERS_FILE = join(HERE, 'users.caddy');
const LATENCY_CALLS = 50;
const STREAM_RUNS = 5;

const results = { date: new Date().toISOString(), model: MODEL, checks: [] };

function log(line) {
  console.log(line);
}

function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function compose(...args) {
  return execFileSync('docker', ['compose', ...args], { cwd: HERE, encoding: 'utf8' });
}

function writeUsers(users) {
  // One line per person: the exact Authorization header, then the name logged for it.
  const lines = Object.entries(users).map(([name, token]) => `"Bearer ${token}" ${name}`);
  writeFileSync(USERS_FILE, `${lines.join('\n')}\n`);
}

function reload() {
  const start = performance.now();
  compose('exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile');
  return performance.now() - start;
}

async function status(url, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(url, { headers });
  await res.arrayBuffer();
  return res.status;
}

async function waitForGate() {
  for (let i = 0; i < 60; i++) {
    try {
      await status(`${GATE}/api/version`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Caddy did not answer on 127.0.0.1:8088');
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function timeCalls(url, token, n) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const times = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    const res = await fetch(url, { headers });
    await res.arrayBuffer();
    times.push(performance.now() - start);
  }
  return times;
}

// Time to the first streamed chunk and to the end, for one short generation.
async function streamOnce(base, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const start = performance.now();
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      prompt: 'Count from 1 to 30, separated by commas.',
      stream: true,
      options: { temperature: 0, num_predict: 80, seed: 1 },
    }),
  });
  const reader = res.body.getReader();
  let first = null;
  let chunks = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      chunks++;
      if (first === null) first = performance.now() - start;
    }
  }
  return { status: res.status, firstChunkMs: first, totalMs: performance.now() - start, chunks };
}

async function run() {
  const alice = randomBytes(24).toString('base64url');
  const bob = randomBytes(24).toString('base64url');
  writeUsers({ alice, bob });

  compose('up', '-d', '--force-recreate');
  try {
    await waitForGate();
    const ollama = (await (await fetch(`${DIRECT}/api/version`)).json()).version;
    const caddy = compose('exec', '-T', 'caddy', 'caddy', 'version').trim().split(' ')[0];
    Object.assign(results, { ollama, caddy });
    log(`Ollama ${ollama}, Caddy ${caddy}, model ${MODEL}\n`);

    // 1. Who gets in.
    check('no token is refused', (await status(`${GATE}/api/tags`)) === 401);
    check('a wrong token is refused', (await status(`${GATE}/api/tags`, 'not-a-token')) === 401);
    check('alice gets in', (await status(`${GATE}/api/tags`, alice)) === 200);
    check('bob gets in', (await status(`${GATE}/api/tags`, bob)) === 200);
    const raw = await fetch(`${GATE}/api/tags`, { headers: { Authorization: alice } });
    await raw.arrayBuffer();
    check('a token without "Bearer " is refused', raw.status === 401);

    // 1b. A valid token is not admin rights. The model names do not exist, so nothing is deleted
    // or downloaded even if the gate let them through: Ollama would answer 404 instead of 403.
    const admin = async (path, method, body, token) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${token ? GATE : DIRECT}${path}`, { method, headers, body });
      await res.arrayBuffer();
      return res.status;
    };
    const ghost = JSON.stringify({ model: 'zz-does-not-exist', stream: false });
    const deleteDirect = await admin('/api/delete', 'DELETE', ghost, null);
    const deleteGate = await admin('/api/delete', 'DELETE', ghost, alice);
    const pullGate = await admin('/api/pull', 'POST', ghost, alice);
    const createGate = await admin('/api/create', 'POST', ghost, alice);
    check(
      'alice cannot delete, pull or create models through the gate',
      deleteGate === 403 && pullGate === 403 && createGate === 403,
      `direct delete ${deleteDirect} (Ollama has no guard), gate: delete ${deleteGate}, pull ${pullGate}, create ${createGate}`,
    );
    const v1 = await fetch(`${GATE}/v1/models`, { headers: { Authorization: `Bearer ${alice}` } });
    await v1.arrayBuffer();
    check('the OpenAI-compatible /v1 API still works for alice', v1.status === 200);

    // 2. Revoke bob without a restart.
    writeUsers({ alice });
    const reloadMs = reload();
    // A connection whose last answer was a refusal is cut by the reload (seen with Caddy 2.11.7):
    // the next request on it fails once with a socket error, so it is retried once and recorded.
    const afterReload = async (token) => {
      try {
        return { code: await status(`${GATE}/api/tags`, token), socketErrors: 0 };
      } catch {
        return { code: await status(`${GATE}/api/tags`, token), socketErrors: 1 };
      }
    };
    const bobTry = await afterReload(bob);
    const aliceTry = await afterReload(alice);
    const bobAfter = bobTry.code;
    const aliceAfter = aliceTry.code;
    results.socketErrorsAfterReload = bobTry.socketErrors + aliceTry.socketErrors;
    log(`Socket errors on the first request after the reload: ${results.socketErrorsAfterReload}`);
    check(
      'bob is refused after his line is removed and Caddy reloads',
      bobAfter === 401 && aliceAfter === 200,
      `reload ${Math.round(reloadMs)} ms, bob ${bobAfter}, alice ${aliceAfter}`,
    );
    results.reloadMs = Math.round(reloadMs);

    // 3. Delay added by the gate (cheap endpoint, so the gate is most of what is measured).
    await timeCalls(`${DIRECT}/api/version`, null, 5);
    await timeCalls(`${GATE}/api/version`, alice, 5);
    const direct = median(await timeCalls(`${DIRECT}/api/version`, null, LATENCY_CALLS));
    const gated = median(await timeCalls(`${GATE}/api/version`, alice, LATENCY_CALLS));
    results.latency = {
      calls: LATENCY_CALLS,
      directMedianMs: +direct.toFixed(2),
      gateMedianMs: +gated.toFixed(2),
      addedMs: +(gated - direct).toFixed(2),
    };
    log(
      `\nDelay, median of ${LATENCY_CALLS} calls to /api/version: direct ${direct.toFixed(1)} ms, ` +
        `through the gate ${gated.toFixed(1)} ms (+${(gated - direct).toFixed(1)} ms)`,
    );

    // 4. Streaming: does the first chunk arrive as fast through the gate?
    await streamOnce(DIRECT, null); // load the model
    const runs = { direct: [], gate: [] };
    for (let i = 0; i < STREAM_RUNS; i++) {
      runs.direct.push(await streamOnce(DIRECT, null));
      runs.gate.push(await streamOnce(GATE, alice));
    }
    const sum = (list) => ({
      firstChunkMedianMs: Math.round(median(list.map((r) => r.firstChunkMs))),
      totalMedianMs: Math.round(median(list.map((r) => r.totalMs))),
      chunksMedian: median(list.map((r) => r.chunks)),
    });
    results.streaming = { runs: STREAM_RUNS, direct: sum(runs.direct), gate: sum(runs.gate) };
    log(
      `Streaming, median of ${STREAM_RUNS}: first chunk direct ${results.streaming.direct.firstChunkMedianMs} ms, ` +
        `gate ${results.streaming.gate.firstChunkMedianMs} ms; chunks direct ${results.streaming.direct.chunksMedian}, ` +
        `gate ${results.streaming.gate.chunksMedian}; total direct ${results.streaming.direct.totalMedianMs} ms, ` +
        `gate ${results.streaming.gate.totalMedianMs} ms\n`,
    );
    const g = results.streaming.gate;
    const d = results.streaming.direct;
    check(
      'streaming still streams through the gate',
      g.chunksMedian > 10 && g.firstChunkMedianMs < d.totalMedianMs / 2,
      `first chunk at ${g.firstChunkMedianMs} ms of ${g.totalMedianMs} ms`,
    );

    // 5. The logs: a name per request, never a token.
    const logs = compose('logs', '--no-color', '--no-log-prefix', 'caddy');
    const access = logs
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l))
      .filter((e) => e.logger?.startsWith('http.log.access'));
    const perUser = {};
    for (const e of access) {
      const who = e.user || '(refused)';
      perUser[who] = (perUser[who] ?? 0) + 1;
    }
    results.logs = { accessLines: access.length, perUser };
    log(`Access log lines: ${access.length}, per person: ${JSON.stringify(perUser)}`);
    check(
      'the log names alice and bob on their requests',
      (perUser.alice ?? 0) > 0 && (perUser.bob ?? 0) > 0,
    );
    check('no token appears in the logs', !logs.includes(alice) && !logs.includes(bob));
    const sample = access.find((e) => e.user === 'alice');
    results.logs.sampleAuthorization = sample?.request?.headers?.Authorization ?? null;
    log(`How Caddy logs the Authorization header: ${JSON.stringify(results.logs.sampleAuthorization)}`);
  } finally {
    compose('down');
    writeFileSync(USERS_FILE, '');
  }

  mkdirSync(join(HERE, 'results'), { recursive: true });
  const file = join(HERE, 'results', `${results.date.replaceAll(':', '-')}.json`);
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.checks.filter((c) => !c.ok).length;
  log(`\n${results.checks.length - failed}/${results.checks.length} checks passed. Results: ${file}`);
  process.exitCode = failed ? 1 : 0;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
