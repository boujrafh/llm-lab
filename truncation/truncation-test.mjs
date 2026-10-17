// Does Ollama silently cut the start of a long prompt? Measures it on this machine.
//
// Usage (Git Bash):  node truncation-test.mjs [model] [runs]
//   default model: llama3.2:3b, default runs: 3 per configuration
//
// The prompt: a rule at the very top ("start with MEMO"), 100 synthetic client notes
// (exactly LATE_CLIENTS of them complain about a late delivery), then the question at the end.
// If Ollama keeps only the end of the prompt, the rule disappears but the question survives.
//
// Two configurations: Ollama's default context, then num_ctx 32768 (what a Modelfile sets).
// Then one request with "truncate": false at the default context, which should be refused (HTTP 400).
// Results: printed table + results/<timestamp>.json. Nothing is installed or changed in Ollama.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL = process.argv[2] ?? 'llama3.2:3b';
const RUNS = Number(process.argv[3] ?? 3);
const HOST = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const LATE_CLIENTS = 18;
const TOTAL_NOTES = 100;

// Deterministic pseudo-random generator: the same document on every machine.
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
const notes = Array.from({ length: TOTAL_NOTES }, (_, i) => {
  const client = `Client ${String(i + 1).padStart(3, '0')}`;
  const topic = lateIndexes.has(i) ? pick(lateTopics) : pick(topics);
  return `Note ${i + 1}. ${client} ${topic}. ${filler}`;
});

function buildPrompt(runId) {
  return [
    `Run ${runId}.`,
    'RULE: start your answer with the word MEMO in capital letters. This rule applies to every answer.',
    '',
    'Here are the client notes of the quarter:',
    ...notes,
    '',
    'QUESTION: how many distinct clients complained about a late delivery? Answer with the number first.',
  ].join('\n');
}

async function generate(prompt, numCtx) {
  const options = { temperature: 0.05 };
  if (numCtx) options.num_ctx = numCtx;
  const res = await fetch(`${HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // keep_alive 0 unloads the model after each run: no cached prompt can make the next read look instant
    // (the "Run N." line alone does not help when truncation drops it). Load time is reported separately.
    body: JSON.stringify({ model: MODEL, prompt, stream: false, options, keep_alive: 0 }),
  });
  if (!res.ok) throw new Error(`Ollama answered ${res.status}: ${await res.text()}`);
  return res.json();
}

function lastTruncationLine() {
  const log = path.join(process.env.LOCALAPPDATA ?? '', 'Ollama', 'server.log');
  if (!existsSync(log)) return null;
  // e.g. level=WARN msg="truncating input prompt" limit=2050 prompt=5488 keep=4 new=2050
  const lines = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('truncating input prompt'));
  return lines.at(-1)?.trim() ?? null;
}

const s = (ns) => Number((ns / 1e9).toFixed(1));
const configs = [
  { name: 'default', numCtx: undefined },
  { name: 'num_ctx 32768', numCtx: 32768 },
];

console.log(`Model ${MODEL}, ${RUNS} runs per configuration, expected answer: ${LATE_CLIENTS}`);
console.log(`Machine: ${os.cpus()[0].model}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM\n`);

const results = [];
let runId = 0;
for (const config of configs) {
  for (let i = 1; i <= RUNS; i++) {
    runId++;
    process.stdout.write(`${config.name.padEnd(14)} run ${i}/${RUNS} ... `);
    const r = await generate(buildPrompt(runId), config.numCtx);
    const answer = r.response.trim();
    const firstNumber = answer.match(/\d+/)?.[0];
    const row = {
      config: config.name,
      run: i,
      promptTokensKept: r.prompt_eval_count,
      startsWithMemo: /^\W*MEMO/.test(answer),
      answeredNumber: firstNumber ? Number(firstNumber) : null,
      correct: Number(firstNumber) === LATE_CLIENTS,
      loadSeconds: s(r.load_duration),
      readSeconds: s(r.prompt_eval_duration),
      readTokensPerSecond: Number((r.prompt_eval_count / (r.prompt_eval_duration / 1e9)).toFixed(1)),
      writeTokensPerSecond: Number((r.eval_count / (r.eval_duration / 1e9)).toFixed(1)),
      totalSeconds: s(r.total_duration),
      answerStart: answer.slice(0, 120),
    };
    results.push(row);
    console.log(
      `kept ${row.promptTokensKept} tokens, MEMO ${row.startsWithMemo ? 'yes' : 'NO'}, ` +
        `answer ${row.answeredNumber ?? '?'} ${row.correct ? '(right)' : '(WRONG)'}, ` +
        `read ${row.readSeconds}s, total ${row.totalSeconds}s`,
    );
  }
}

// Same prompt, default context, but asking Ollama not to truncate: it should refuse instead of cutting.
process.stdout.write('truncate false  once ... ');
const refused = await fetch(`${HOST}/api/generate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: MODEL, prompt: buildPrompt(++runId), stream: false, truncate: false, keep_alive: 0 }),
});
const truncateFalse = { httpStatus: refused.status, body: (await refused.text()).slice(0, 300) };
console.log(`HTTP ${truncateFalse.httpStatus} ${truncateFalse.body}`);

const truncation = lastTruncationLine();
console.log(`\nLast truncation line in Ollama's log:\n${truncation ?? '(none found)'}`);

mkdirSync('results', { recursive: true });
const file = path.join('results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      model: MODEL,
      expected: LATE_CLIENTS,
      machine: { cpu: os.cpus()[0].model, ramGB: Math.round(os.totalmem() / 2 ** 30), os: os.version() },
      ollamaVersion: (await (await fetch(`${HOST}/api/version`)).json()).version,
      results,
      truncateFalse,
      truncationLogLine: truncation,
    },
    null,
    2,
  ),
);
console.log(`Saved ${file}`);
