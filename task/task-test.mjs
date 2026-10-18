// Does a model hold on a real task, run after run? Scored against the known answer, no LLM judge.
//
// Usage (Git Bash):  node task-test.mjs [runs] [model ...]
//   default runs: 10 per task; default models: every installed model except embedding models
//
// The document: the same 100 synthetic client notes as the truncation test (same seed, so exactly
// the same 18 late-delivery complaints). Two tasks on that document, as in the course's method:
//   count: "how many distinct clients complained about a late delivery?"  (right answer: 18)
//   list:  "list every one of them, one per line"                         (right answer: the 18 IDs)
// Because the data is synthetic, the script knows the answer and scores each run itself.
//
// Settings: num_ctx 8192 so the ~5,500-token prompt is never truncated (checked on the first run),
// and each model's own default temperature, with a different seed per run: what a client gets
// out of the box. The notes come first and the task last, so Ollama can reuse the document it has
// already read: timings here are not reading speeds, see the speed test for those.
// Results: printed summary + results/<timestamp>.json with every raw answer.

import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = Number(process.argv[2] ?? 10);
const HOST = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const NUM_CTX = 8192;
const LATE_CLIENTS = 18;
const TOTAL_NOTES = 100;

// --- Same document generator as truncation/truncation-test.mjs (seed 42) ---
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (list) => list[Math.floor(rand() * list.length)];
const topics = [
  'asked for a copy of last quarter invoice and the payment terms',
  'wants to add two users to the support contract next month',
  'reported that the new dashboard is easier to read than the old one',
  'asked whether the training session can move to a Thursday afternoon',
  'confirmed the meeting notes and approved the revised quote',
  'raised a question about data retention for archived projects',
  'thanked the team for the quick answer on the VPN configuration',
  'requested a summary of open tickets before the quarterly review',
];
const lateTopics = [
  'complained that the delivery arrived nine days after the promised date',
  'is unhappy because the shipment was late again this month',
  'says the order was delivered late and the site team lost a full day',
];
const filler =
  'The account manager logged the call, checked the history of the account, and added a follow-up task ' +
  'for the next weekly review. No other action was requested during this exchange.';
const lateIndexes = new Set();
while (lateIndexes.size < LATE_CLIENTS) lateIndexes.add(Math.floor(rand() * TOTAL_NOTES));
const clientId = (i) => `Client ${String(i + 1).padStart(3, '0')}`;
const notes = Array.from({ length: TOTAL_NOTES }, (_, i) => {
  const topic = lateIndexes.has(i) ? pick(lateTopics) : pick(topics);
  return `Note ${i + 1}. ${clientId(i)} ${topic}. ${filler}`;
});
const expectedClients = [...lateIndexes].sort((a, b) => a - b).map(clientId);
// --------------------------------------------------------------------------

const documentPart = ['Here are the client notes of the quarter:', ...notes, ''].join('\n');
const tasks = {
  count:
    'TASK: how many distinct clients complained about a late delivery? ' +
    'Answer with the number only.',
  list:
    'TASK: list every client who complained about a late delivery, one per line, in the form "Client 000". ' +
    'Include all of them and nothing else.',
};

const api = async (route, body) => {
  const res = await fetch(`${HOST}${route}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`${route}: Ollama answered ${res.status}: ${await res.text()}`);
  return res.json();
};

const version = (await api('/api/version')).version;
const tags = (await api('/api/tags')).models;
let models = process.argv.slice(3);
if (models.length === 0) models = tags.map((m) => m.name).filter((n) => !/embed/i.test(n));

// node:http, not fetch: on a CPU a big model can read for more than 5 minutes before Ollama sends
// anything, and fetch gives up after 5 minutes without headers. http.request has no such limit.
function ask(model, task, run) {
  const body = JSON.stringify({
    model,
    prompt: `${documentPart}\n${tasks[task]}`,
    stream: false,
    think: /gpt-oss/.test(model) ? 'low' : undefined, // reasoning models: keep thinking short
    options: { num_ctx: NUM_CTX, seed: 1000 + run, num_predict: 2048 },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(`${HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Ollama answered ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const firstNumber = (text) => {
  const m = text.match(/\d+/);
  return m ? Number(m[0]) : null;
};
const listedClients = (text) =>
  [...new Set([...text.matchAll(/client\s*#?\s*(\d{1,3})\b/gi)].map((m) => `Client ${m[1].padStart(3, '0')}`))];

const results = [];
const startedAt = new Date().toISOString();
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${startedAt.replace(/[:.]/g, '-')}.json`);
const save = () => writeFileSync(file, JSON.stringify({
  date: startedAt,
  machine: { cpu: os.cpus()[0]?.model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), platform: `${os.platform()} ${os.release()}` },
  ollama: version, numCtx: NUM_CTX, runsPerTask: RUNS,
  expected: { count: LATE_CLIENTS, clients: expectedClients },
  tasks,
  models: results,
}, null, 2));

console.log(`${RUNS} runs per task, expected: ${LATE_CLIENTS} clients\n`);
for (const model of models) {
  if (!tags.find((t) => t.name === model)) { console.error(`skip ${model}: not installed`); continue; }
  const show = await api('/api/show', { model });
  const temperature = /temperature\s+([\d.]+)/.exec(show.parameters ?? '')?.[1] ?? 'Ollama default (0.8)';
  const row = { model, temperature, firstPromptTokens: null, count: [], list: [] };
  results.push(row);

  for (const task of ['count', 'list']) {
    for (let run = 1; run <= RUNS; run++) {
      process.stdout.write(`\r${model} ${task} ${run}/${RUNS}   `);
      const started = Date.now();
      const r = await ask(model, task, run);
      const answer = (r.response ?? '').trim();
      // Later runs reuse the cached document, so only the very first run shows the full prompt size.
      if (row.firstPromptTokens === null) row.firstPromptTokens = r.prompt_eval_count;
      const base = { run, seconds: Math.round((Date.now() - started) / 1000), answer: answer.slice(0, 1500) };
      if (task === 'count') {
        const number = firstNumber(answer);
        row.count.push({ ...base, number, correct: number === LATE_CLIENTS });
      } else {
        const found = listedClients(answer);
        const missing = expectedClients.filter((c) => !found.includes(c));
        const extra = found.filter((c) => !expectedClients.includes(c));
        row.list.push({ ...base, listed: found.length, missing, extra, exact: missing.length === 0 && extra.length === 0 });
      }
      save(); // after every run: a run can take minutes, a crash must not lose the ones already done
    }
  }
  await api('/api/generate', { model, keep_alive: 0 });

  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  row.summary = {
    countCorrect: `${row.count.filter((c) => c.correct).length}/${RUNS}`,
    countAnswers: [...new Set(row.count.map((c) => c.number))].join(', '),
    listExact: `${row.list.filter((l) => l.exact).length}/${RUNS}`,
    listMedianRightIds: median(row.list.map((l) => l.listed - l.extra.length)),
    listMaxWrongIds: Math.max(...row.list.map((l) => l.extra.length)),
  };
  save();
  console.log(`\r${model}: prompt ${row.firstPromptTokens} tokens, count right ${row.summary.countCorrect} ` +
    `(answers: ${row.summary.countAnswers}), list exact ${row.summary.listExact}`);
}

console.log('');
console.table(results.map((r) => ({ model: r.model, temperature: r.temperature, ...r.summary })));
console.log(`\nSaved ${file}`);
