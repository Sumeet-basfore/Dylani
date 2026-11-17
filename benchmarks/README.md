# Dylani benchmark foundation

This standalone package records comparable Dylani UI generation runs without changing the studio UI or adding a provider.

## Corpus and variants

[`prompts.json`](prompts.json) is the version-controlled 10-prompt corpus: three SaaS dashboards, three landing pages, two developer portfolios, and two e-commerce interfaces.

- **Baseline** sends the functional requirements directly with the shared DesignSpec 1.0 JSON output contract.
- **Optimized** uses Dylani's current skill selection and `buildDesignSpecPrompt` workflow.

Both variants use the same configured model, FreeLLMAPI-compatible endpoint, temperature, token limit, DesignSpec validator, fixed React + TypeScript + Vite + Tailwind project template, isolated build runner, and preview policies. The optimized prompt adds only the existing Dylani skill guidance and structured workflow. A live call uses one inference request per prompt per variant. Token usage is recorded when the gateway supplies it.

## Deterministic fixture run

No credentials or network calls are needed:

```bash
npm run run --prefix benchmarks -- --fixture
npm run test --prefix benchmarks
```

Use `--prompt-id <id>` to run one corpus item, and `--output <directory>` to choose another local run root. Fixture mode validates the run recorder, build wiring, artifact layout, and anonymized report. Its synthetic DesignSpecs do not measure a model's design quality.

## Live FreeLLMAPI-compatible run

Inject credentials and model identity into the process environment. Do not put keys in arguments, repository files, or model prompts.

```bash
export FREELLMAPI_BASE_URL=http://127.0.0.1:3001/v1
export DYLANI_BENCHMARK_API_KEY=<local-unified-key>
export DYLANI_BENCHMARK_MODEL=<model-id>
npm run run --prefix benchmarks
```

The runner calls `POST /chat/completions`; errors are reduced to safe status labels. Credentials are not written to run files or printed. A live run uses authenticated inference only when valid credentials and a working gateway are available.

## Run artifacts and report

Each invocation creates a new run directory under `benchmarks/runs/` by default. Existing files are opened with exclusive-create semantics and never overwritten. A run contains:

- `run.json`: immutable run metadata, prompt-to-variant A/B mapping, provider/model identity, generation settings, token/request counts, build results, runtime errors, responsive overflow checks, accessibility findings, and elapsed times.
- `artifacts/<prompt-id>/<A-or-B>/source/`: the fixed generated project source.
- `artifacts/<prompt-id>/<A-or-B>/mobile.png` and `desktop.png`: screenshots at 390×844 and 1440×900 when Chromium is available.
- `comparison.html`: side-by-side screenshots with per-prompt randomized A/B labels. It does not reveal the pipeline mapping and leaves human ratings unassigned.

The default renderer uses the same preview origin inside a `sandbox="allow-scripts"` iframe without `allow-same-origin`. Browser runtime errors are captured, along with horizontal overflow and preliminary DOM accessibility checks (document language, unlabeled controls, missing image alt text, and empty buttons). These checks are not a complete WCAG audit and do not produce a numerical visual-quality score. If Chromium is unavailable, screenshot and browser findings are marked skipped; generation/build data remains recorded.

The generated report is for human review. The pipeline does not create, infer, or fill in reviewer ratings.
