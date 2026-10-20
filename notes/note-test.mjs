// Same task as ../task, split into small questions: does a small model get it right
// when it reads one note at a time and the code does the counting?
//
// Usage (Git Bash):  node note-test.mjs [runs] [model ...]
//   default runs: 10; default models: the 4 small models of the task test
//
// The document: the same 100 synthetic client notes (same seed, so exactly the same 18 late-delivery
// complaints). For each note the model gets one short question: "does this note say the client
// complained about a late delivery? yes or no". The code then counts the "yes" answers and lists the
// clients. Scored against the known answer, no LLM judge.
//
// One run = 100 calls. Settings: each model's own default temperature, a different seed per run,
// Ollama's default context (a note is ~80 tokens). The question comes first and the note last, so
// Ollama can reuse the question it has already read. Timing = wall time for the 100 calls.
// Results: printed summary + results/<timestamp>.json with every answer that was not a plain
// right yes/no.

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = Number(process.argv[2] ?? 10);
const HOST = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const LATE_CLIENTS = 18;
const TOTAL_NOTES = 100;
const DEFAULT_MODELS = ['llama3.2:1b', 'llama3.2:3b', 'qwen2.5:3b', 'llama3.1:8b'];

// --- Same document generator as truncation/ and task/ (seed 42) ---
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
const noteTopics = [];
const notes = Array.from({ length: TOTAL_NOTES }, (_, i) => {
  const topic = lateIndexes.has(i) ? pick(lateTopics) : pick(topics);
  noteTopics.push(topic);
  return `Note ${i + 1}. ${clientId(i)} ${topic}. ${filler}`;
});
const expectedClients = [...lateIndexes].sort((a, b) => a - b).map(clientId);
// --------------------------------------------------------------------------

const question =
  'QUESTION: does the client note below say that the client complained about a late delivery? ' +
  'Answer with one word: yes or no.\n\n';

const api = async (route, body) => {
  const res = await fetch(`${HOST}${route}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  if (!res.ok) throw new Error(`${route}: Ollama answered ${res.status}: ${await res.text()}`);
  return res.json();
};

// "Yes.", "**No**", "yes, the client..." all count; anything else is "unclear" and counts as no.
const readAnswer = (text) => {
  const m = text.trim().match(/^[^a-z]*(yes|no)\b/i);
  return m ? m[1].toLowerCase() : 'unclear';
};

const version = (await api('/api/version')).version;
const tags = (await api('/api/tags')).models;
const models = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_MODELS;

const results = [];
const startedAt = new Date().toISOString();
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${startedAt.replace(/[:.]/g, '-')}.json`);
const save = () => writeFileSync(file, JSON.stringify({
  date: startedAt,
  machine: { cpu: os.cpus()[0]?.model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), platform: `${os.platform()} ${os.release()}` },
  ollama: version, runs: RUNS, callsPerRun: TOTAL_NOTES,
  expected: { count: LATE_CLIENTS, clients: expectedClients },
  question,
  models: results,
}, null, 2));

console.log(`${RUNS} runs of ${TOTAL_NOTES} questions per model, expected: ${LATE_CLIENTS} clients\n`);
for (const model of models) {
  if (!tags.find((t) => t.name === model)) { console.error(`skip ${model}: not installed`); continue; }
  const show = await api('/api/show', { model });
  const temperature = /temperature\s+([\d.]+)/.exec(show.parameters ?? '')?.[1] ?? 'Ollama default (0.8)';
  // A reasoning model (gpt-oss…) writes its reasoning before the answer, and those tokens count
  // against num_predict: 10 tokens would cut it off before it says yes or no.
  const thinking = (show.capabilities ?? []).includes('thinking');
  const numPredict = thinking ? 2048 : 10;
  const row = { model, temperature, thinking, runs: [] };
  results.push(row);

  for (let run = 1; run <= RUNS; run++) {
    const started = Date.now();
    const yes = [];
    const odd = []; // wrong or unclear answers, kept raw for the article
    for (let i = 0; i < TOTAL_NOTES; i++) {
      process.stdout.write(`\r${model} run ${run}/${RUNS} note ${i + 1}/${TOTAL_NOTES}   `);
      const r = await api('/api/generate', {
        model,
        prompt: question + notes[i],
        stream: false,
        options: { seed: 1000 + run, num_predict: numPredict },
      });
      const raw = (r.response ?? '').trim();
      const answer = readAnswer(raw);
      if (answer === 'yes') yes.push(clientId(i));
      const late = lateIndexes.has(i);
      if (answer === 'unclear' || (answer === 'yes') !== late) {
        odd.push({ note: i + 1, late, topic: noteTopics[i], answer, raw: raw.slice(0, 200) });
      }
    }
    const missing = expectedClients.filter((c) => !yes.includes(c));
    const extra = yes.filter((c) => !expectedClients.includes(c));
    row.runs.push({
      run,
      seconds: Math.round((Date.now() - started) / 1000),
      count: yes.length,
      correct: yes.length === LATE_CLIENTS,
      exact: missing.length === 0 && extra.length === 0,
      missing, extra,
      unclear: odd.filter((o) => o.answer === 'unclear').length,
      odd,
    });
    save(); // after every run: a crash must not lose the runs already done
  }
  await api('/api/generate', { model, keep_alive: 0 });

  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  // Which late-delivery wordings the model misses most (the task test showed the 8B missing one).
  const missedByWording = Object.fromEntries(lateTopics.map((t) => [t, 0]));
  for (const r of row.runs) for (const o of r.odd) if (o.late) missedByWording[o.topic]++;
  row.summary = {
    countCorrect: `${row.runs.filter((r) => r.correct).length}/${RUNS}`,
    countAnswers: [...new Set(row.runs.map((r) => r.count))].join(', '),
    listExact: `${row.runs.filter((r) => r.exact).length}/${RUNS}`,
    maxMissing: Math.max(...row.runs.map((r) => r.missing.length)),
    maxWrongIds: Math.max(...row.runs.map((r) => r.extra.length)),
    medianSecondsPerRun: median(row.runs.map((r) => r.seconds)),
  };
  row.missedByWording = missedByWording;
  save();
  console.log(`\r${model}: count right ${row.summary.countCorrect} (answers: ${row.summary.countAnswers}), ` +
    `list exact ${row.summary.listExact}, ~${row.summary.medianSecondsPerRun} s per run          `);
}

console.log('');
console.table(results.map((r) => ({ model: r.model, temperature: r.temperature, ...r.summary })));
console.log(`\nSaved ${file}`);
