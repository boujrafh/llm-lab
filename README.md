# llm-lab

Small, reproducible measurements of local language models, run on ordinary hardware.
Each folder is one experiment, with the script, how to run it, and the raw results.

## truncation

Does Ollama silently cut the start of a long prompt? A 5,488-token prompt with a rule at the top,
100 synthetic client notes (18 late deliveries) and a question at the end, run with Ollama's default
context and with `num_ctx 32768`.

```bash
cd truncation
node truncation-test.mjs llama3.2:3b 3   # model, runs per configuration
```

Requirements: Node.js 18+ and Ollama running on `http://localhost:11434` (override with
`OLLAMA_URL`). The script installs nothing and changes no Ollama setting; it unloads the model after
each run so cached prompts cannot distort the timings. Results go to `truncation/results/`.

`results/2026-10-17T11-40-30-078Z.json`: Intel i7-8665U, 32 GB RAM, no GPU, Ollama 0.40.5,
`llama3.2:3b`. Its default-configuration runs 2 and 3 show 0.2 s reading times: they reused a cached
prompt (fixed since); only run 1 timing is valid.

## speed

Can you predict how fast a model will write before downloading it? The rule of thumb says
`tokens/s ≈ memory bandwidth ÷ weights read per token`. The script prints that prediction next to
the measured speed for every installed model, including a mixture-of-experts model (`gpt-oss:20b`),
which reads only part of its weights per token.

```bash
cd speed
node speed-test.mjs 3                          # 3 runs per model, every installed model
node speed-test.mjs 3 llama3.2:3b gpt-oss:20b  # or a chosen list
```

The default bandwidth (38.4 GB/s) is the theoretical figure for dual-channel DDR4-2400; set
`BANDWIDTH_GBS` for your machine. Close other heavy programs first: a download running in the
background slowed the first smoke test (`results/smoke/`). Results go to `speed/results/`.

Method inspired by the "Kit IA locale" masterclass on local AI agents
([video](https://www.youtube.com/watch?v=MNFZoZUExSQ)).
