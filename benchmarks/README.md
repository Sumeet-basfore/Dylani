# Dylani benchmark pilot

This package compares the same pinned model and fixed React template across two prompts: a baseline raw task prompt with the DesignSpec JSON contract, and an optimized prompt using Dylani's existing skill selection and DesignSpec workflow. It makes no model-selection or cross-model fallback decisions.

## Prompt set and controlled settings

[`prompts.json`](prompts.json) contains 10 version-controlled prompts: three SaaS dashboards, three landing pages, two developer portfolios, and two e-commerce interfaces. Each prompt's requirements, DesignSpec validator, fixed React + TypeScript + Vite + Tailwind template, isolated build runner, preview policy, temperature (`0.2`), token cap (`4000`), and non-streaming mode are shared by both variants. Only the prompt treatment changes. Each candidate gets one initial request and at most one additional recovery request for invalid JSON or DesignSpec output; both variants use the same recovery policy and per-request settings. The manifest records each attempt, its prompt hash, output, validation failure, token use, model identity, and latency, plus source hashes for the benchmark pipeline, prompt corpus, skill prompt builder, DesignSpec schema, project generator, isolated worker, and pinned toolchain lockfile.

The recorded requested model ID is fixed for a run. Every provider response must include an exactly matching `model` identity before its DesignSpec can build. Missing or different identity makes that candidate ineligible for build and records a safe failure. Raw invalid model output is retained under the candidate artifact after configured credentials are redacted. Actual serving identity, generation attempts, inference requests, available token usage, generation/build/capture time, and failures are retained in `run.json`.

## Deterministic fixture run

No gateway or credentials are needed:

```bash
npm run run --prefix benchmarks -- --fixture
npm run test --prefix benchmarks
```

Use `--prompt-id <id>` for a small fixture smoke run, or omit it to exercise all 10 prompts. Fixtures test generation, build/capture wiring, immutable artifacts, and report production. They are synthetic examples and do not provide evidence about model design quality.

## Live inference

FreeLLMAPI is the default provider. Inject the unified key and pinned model through the environment; never pass credentials as command-line arguments or write them into files:

```bash
export DYLANI_BENCHMARK_PROVIDER=freellmapi
export FREELLMAPI_BASE_URL=http://127.0.0.1:3001/v1
export DYLANI_BENCHMARK_API_KEY=<local-unified-key>
export DYLANI_BENCHMARK_MODEL=<exact-model-id>
npm run run --prefix benchmarks
```

If no valid FreeLLMAPI key is available, an installed local Ollama model can be selected explicitly:

```bash
npm run run --prefix benchmarks -- --provider ollama --model qwen3:4b
```

Ollama defaults to `http://127.0.0.1:11434`; `--base-url` or `DYLANI_BENCHMARK_BASE_URL` can select another loopback address. Non-loopback URLs are rejected for Ollama. The runner uses Ollama's native `POST /api/chat` endpoint with `think:false`, applies the same DesignSpec JSON Schema output constraint to both variants, and maps its token usage into the common report. Ollama documents schema objects in `format` for local chat; its documentation currently says Ollama Cloud does not support structured outputs. Post-generation Zod validation remains required because the JSON Schema cannot encode Dylani's global ID uniqueness refinement. It sends no Authorization header. A local no-auth endpoint is used only after explicitly selecting Ollama. The requested model must already be available; Dylani never pulls or switches models. Other OpenAI-compatible providers are not currently enabled.

`--provider`, `--model`, and `--base-url` override environment configuration for that run. FreeLLMAPI requires `DYLANI_BENCHMARK_API_KEY`; Ollama does not use that key. Provider errors are reduced to safe status labels. Secrets are not included in logs or run metadata. The second request, when needed, carries a bounded validation-recovery instruction and uses the same exact model and generation settings as the first request.

Approximate cost is unknown by default. To calculate an estimate, configure both rates from a trusted price source (USD per million tokens):

```bash
export DYLANI_BENCHMARK_INPUT_USD_PER_MILLION=<input-rate>
export DYLANI_BENCHMARK_OUTPUT_USD_PER_MILLION=<output-rate>
```

The report marks the estimate and shows token-usage coverage. No price is inferred from model identity.

## Artifacts and reports

Each run creates a new exclusive-write directory under `benchmarks/runs/` by default. Once complete, files are marked read-only and directories read/execute-only on POSIX systems; the runner does not overwrite existing artifacts. The run contains:

- `run.json`: private run manifest, exact requirements and prompt hashes, prompt-to-variant mapping, randomized candidate/position mappings, requested and actual model IDs, settings, source hashes, counts, timings, build/runtime/responsive/accessibility findings, token totals, and missing-data metrics.
- `artifacts/<prompt-id>/<A-or-B>/source/`: fixed generated project source for valid DesignSpecs.
- `artifacts/<prompt-id>/<A-or-B>/generation-output-attempt-<n>.txt`: each bounded model response, including failed responses, with configured credentials redacted.
- `artifacts/<prompt-id>/<A-or-B>/mobile.png` and `desktop.png`: 390×844 and 1440×900 screenshots when Chromium is available.
- `blind-review/`: shareable review package containing only candidate screenshots, the blind rating page, and instructions. It does not contain the manifest or generated source.
- `summary.html`: run diagnostics, build success, runtime failures, request/token/latency data, accessibility heuristics, cost estimate if configured, and any imported human preferences.

The blind report randomizes which pipeline is Candidate A/B and independently randomizes left/right order per prompt. It shows the same viewport sizes and functional requirements for both candidates. Only prompts with a complete screenshot pair for both candidates can be rated. Reviewers enter a unique alias, rate visual quality and task fulfillment from 1 to 5, and choose A, B, or tie. Ratings are blank until humans provide them. The page downloads a separate JSON file per reviewer; keep those original files unchanged. Share only `blind-review/` before ratings are collected so reviewers cannot inspect `run.json` or source files. POSIX read-only permissions help prevent accidental edits; the directory owner can change them, so this is not tamper-proof archival storage.

Regenerate a diagnostics report from an existing run without changing its manifest or artifacts:

```bash
npm run report --prefix benchmarks -- \
  --run benchmarks/runs/<run-id>
```

After collecting reviewer JSON files, include them in a separate report directory:

```bash
npm run report --prefix benchmarks -- \
  --run benchmarks/runs/<run-id> \
  --ratings ./reviews/reviewer-01.json \
  --ratings ./reviews/reviewer-02.json
```

The report writes a separate `summary.html` and `summary.json`; with ratings it also preserves each individual rating file and includes per-prompt/overall preference counts. Reports include responsive overflow checks, build/runtime outcomes, and missing viewport data. They do not turn ratings into a system-assigned visual-quality score or claim statistical significance. To distinguish improvement from disagreement, retain each reviewer and prompt result, report raw counts and ties, inspect disagreement by prompt, and agree on a sample-size/statistical plan before making broader claims.

## Pilot reports

- [M1.3 validation diagnosis and prompt matrix](reports/milestone-1.3-diagnosis.md)
- [M1.4 bounded recovery results and human-review status](reports/milestone-1.4-reliability.md)

M1.4's 100% post-recovery DesignSpec validity is a same-corpus technical diagnostic after inspecting M1.3 failures. It is not an independent holdout result and does not establish design-quality improvement. The run manifest and per-attempt outputs are stored locally under the ignored `benchmarks/runs/` directory.

Build status, runtime exceptions, horizontal overflow, generation latency, and lightweight accessibility findings are measured for each successful candidate. Accessibility checks cover document language, unlabeled controls, missing image `alt` text, and empty buttons; they are not a WCAG audit. If Chromium or the isolated runner is unavailable, missing capture/build data is reported rather than fabricated.
