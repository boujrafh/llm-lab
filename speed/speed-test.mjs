// Predicted vs measured writing speed of local models on this machine (CPU only works too).
//
// Usage (Git Bash):  node speed-test.mjs [runs] [model ...]
//   default runs: 3; default models: every model Ollama has, except embedding models
//   BANDWIDTH_GBS=38.4 overrides the memory bandwidth used for the prediction
//
// The rule being tested: each new token reads every active weight once from memory, so
//   max tokens/s ≈ memory bandwidth ÷ bytes of weights read per token.
// For a dense model that is the whole file. For a mixture-of-experts model only the experts used
// per token are read, so the estimate scales the file by (experts used ÷ experts total). That is
// rough: shared layers are read every time, so the true figure sits between the two numbers.
//
// For each model: one warm-up request (loads it, not counted), then [runs] requests with a
// different first line each time so no cached prompt is reused. Records writing speed (eval),
// reading speed (prompt eval), and what `ollama ps` reports (memory, share on the GPU, context).
// Results: printed table + results/<timestamp>.json. Nothing is installed or changed in Ollama.

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS = Number(process.argv[2] ?? 3);
const HOST = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const BANDWIDTH_GBS = Number(process.env.BANDWIDTH_GBS ?? 38.4); // 2 channels × 8 bytes × 2400 MT/s
const NUM_PREDICT = 200;

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

// About 150 words of neutral text to read, then an open question so the model writes until NUM_PREDICT.
const context =
  'A small accounting firm wants an assistant that drafts replies to client emails. ' +
  'The firm has five employees, one shared office server, and strict rules about client data: ' +
  'nothing may leave the building. Most emails ask about deadlines, missing documents, invoices, ' +
  'and appointments. The partners want short, polite replies in plain language, which an employee ' +
  'always reviews before sending. They also want the assistant to flag any email that mentions a ' +
  'dispute, a tax audit, or a complaint, so a partner can answer it personally. The server is a ' +
  'standard office machine without a graphics card. The firm has no IT staff and wants something ' +
  'that keeps working after a power cut without anyone touching it.';
const prompt = (i) =>
  `Request ${i}.\n${context}\n\nExplain, step by step and in detail, how you would set up and test this assistant.`;

const generate = (model, i) =>
  api('/api/generate', {
    model,
    prompt: prompt(i),
    stream: false,
    options: { temperature: 0, seed: 42, num_predict: NUM_PREDICT },
  });

const rate = (count, ns) => (ns > 0 ? count / (ns / 1e9) : 0);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const r1 = (x) => Math.round(x * 10) / 10;

const results = [];
for (const model of models) {
  const tag = tags.find((t) => t.name === model);
  if (!tag) { console.error(`skip ${model}: not installed`); continue; }
  const show = await api('/api/show', { model });
  const info = show.model_info ?? {};
  const arch = info['general.architecture'];
  const expertsTotal = info[`${arch}.expert_count`] ?? 0;
  const expertsUsed = info[`${arch}.expert_used_count`] ?? 0;
  const fileGB = tag.size / 1e9;
  const readGB = expertsTotal ? fileGB * (expertsUsed / expertsTotal) : fileGB;

  process.stdout.write(`${model}: loading… `);
  const warm = await generate(model, 0);
  const ps = (await api('/api/ps')).models.find((m) => m.name === model) ?? {};

  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await generate(model, i);
    runs.push({
      evalTokens: r.eval_count,
      evalRate: rate(r.eval_count, r.eval_duration),
      promptTokens: r.prompt_eval_count,
      promptRate: rate(r.prompt_eval_count, r.prompt_eval_duration),
      totalSeconds: r.total_duration / 1e9,
    });
    process.stdout.write(`${i} `);
  }
  await api('/api/generate', { model, keep_alive: 0 }); // unload before the next model
  console.log('done');

  results.push({
    model,
    parameters: show.details?.parameter_size,
    quantization: show.details?.quantization_level,
    fileGB: r1(fileGB),
    experts: expertsTotal ? `${expertsUsed}/${expertsTotal}` : null,
    predictedMaxDense: r1(BANDWIDTH_GBS / fileGB),
    predictedMax: r1(BANDWIDTH_GBS / readGB),
    measuredEvalMedian: r1(median(runs.map((x) => x.evalRate))),
    measuredPromptMedian: r1(median(runs.map((x) => x.promptRate))),
    loadSeconds: r1(warm.load_duration / 1e9),
    memoryGB: ps.size ? r1(ps.size / 1e9) : null,
    gpuShare: ps.size ? `${Math.round((100 * (ps.size_vram ?? 0)) / ps.size)}%` : null,
    contextLength: ps.context_length ?? null,
    runs,
  });
}

console.log(`\nOllama ${version}, bandwidth used for the prediction: ${BANDWIDTH_GBS} GB/s\n`);
console.table(results.map(({ runs, ...row }) => row));

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({
  date: new Date().toISOString(),
  machine: { cpu: os.cpus()[0]?.model, threads: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9), platform: `${os.platform()} ${os.release()}` },
  ollama: version, bandwidthGBs: BANDWIDTH_GBS, numPredict: NUM_PREDICT, runsPerModel: RUNS,
  results,
}, null, 2));
console.log(`\nSaved ${file}`);
