# Milestone 1.4 reliability report

## M1.3 failure diagnosis

The immutable M1.3 manifest and all six failed response files were inspected without modifying the run. All six responses were parseable DesignSpec 1.0 JSON. Each failed only the global component/child ID uniqueness refinement. The repeated IDs were `text`, `label`, `metric`, and `button`; baseline had three failures and optimized had three. Both variants failed `landing-03-climate-reporting` because they repeated `text` child IDs. The full cause table and per-prompt initial result matrix are in [milestone-1.3-diagnosis.md](milestone-1.3-diagnosis.md).

Ollama 0.33.3 accepted the native `/api/chat` JSON Schema `format` used by the runner. The [Ollama structured outputs guide](https://docs.ollama.com/capabilities/structured-outputs), checked 2026-11-17, documents a JSON Schema object in `format` for local chat and recommends parsing/validating the result. Ollama Cloud is explicitly outside this experiment and the guide says it currently lacks structured outputs. Dylani's cross-component uniqueness rule is a Zod `superRefine`, which generated JSON Schema cannot express, so post-response validation is still required.

## Recovery policy

The reliability run used the same pinned local model, prompts, generation settings, templates, and fixed isolated build path as M1.3. It changed only the bounded format-recovery policy: at most one additional request after invalid JSON or DesignSpec validation. The retry repeats the selected variant's original prompt and adds the validation category plus the shared rule to use globally unique IDs. Baseline and optimized have the same two-attempt maximum and token limit per attempt. Every response, validation failure, model identity, token usage, latency, and per-attempt prompt hash is preserved. There is no model fallback or retry after a provider error or identity mismatch.

## Prompt-level technical outcome

| Prompt | M1.3 baseline | M1.3 optimized | M1.4 baseline | M1.4 optimized |
|---|---|---|---|---|
| SaaS operations dashboard | Failed: duplicate `text` | Valid | Valid, first attempt | Valid, first attempt |
| SaaS support analytics | Valid | Valid | Valid, first attempt | Valid, first attempt |
| SaaS subscription health | Valid | Failed: duplicate `label` | Valid, first attempt | Recovered on attempt 2 |
| Finance product landing page | Valid | Failed: duplicate `text`, `metric` | Recovered on attempt 2 | Valid, first attempt |
| Team planning landing page | Valid | Valid | Valid, first attempt | Recovered on attempt 2 |
| Climate reporting landing page | Failed: duplicate `text` | Failed: duplicate `text` | Recovered on attempt 2 | Recovered on attempt 2 |
| Product designer portfolio | Valid | Valid | Valid, first attempt | Valid, first attempt |
| Frontend engineer portfolio | Failed: duplicate `text`, `button` | Valid | Recovered on attempt 2 | Recovered on attempt 2 |
| Home goods commerce | Valid | Valid | Valid, first attempt | Valid, first attempt |
| Outdoor gear commerce | Valid | Valid | Valid, first attempt | Valid, first attempt |

## Measurements

| Measure | M1.3 initial run | M1.4 reliability run |
|---|---:|---:|
| DesignSpec validity, baseline | 7/10 | 10/10 after recovery (3 recovered) |
| DesignSpec validity, optimized | 7/10 | 10/10 after recovery (4 recovered) |
| Total inference requests / attempts | 20 / 20 | 27 / 27 |
| Recovered candidates / failed attempts | 0 / not separately logged | 7 / 7, all recovered |
| Retry token usage | — | 3,302 prompt + 4,366 completion = 7,668 total |
| Total token usage | 18,600 | 26,329 |
| Generation / pipeline elapsed time | 212,288 / 291,973 ms | 308,075 / 431,273 ms |
| Builds | 14/14 generated candidates | 20/20 candidates |
| Desktop/mobile screenshots | 28/28 successful-candidate captures | 40/40 |
| Runtime errors | 0 | 0 |
| Horizontal overflow | 0/28 viewport checks | 0/40 viewport checks |
| Accessibility heuristic findings | 0 across 28 viewport checks | 0 across 40 viewport checks |
| Serving-model mismatches | 0 | 0 across 27 requests |
| Approximate cost | Unknown | Unknown |

The M1.4 run is a same-corpus reliability diagnostic after inspecting M1.3 failures. Its 100% post-recovery validity is an in-sample technical result, not an independent held-out estimate. Neither run has human ratings for the design-quality hypothesis. Zero accessibility heuristic findings do not demonstrate WCAG conformance.

## Verification and remaining dependency risk

On 2026-11-17, verification completed with 41/41 repository tests passing, 14/14 benchmark tests passing, and 5 browser tests passing with 1 skipped because WebKit was unavailable. Frontend/design-spec typecheck and production build passed. The live browser suite exercised Chromium and Firefox; the skipped WebKit case is not counted as verified. `git diff --check` passed.

Both dependency audits remain nonzero: the root audit reports 4 high-severity vulnerable packages and the isolated runner toolchain audit reports 11. The finding is `picomatch` ReDoS advisory GHSA-fc5q-39xc-vjpf, affecting the locked 4.0.7 and 2.3.2 copies used through Vite/Tailwind dependencies. At verification time, the npm registry exposed no patched `picomatch` release; npm's suggested `--force` remediation downgrades Vite to 6.2.7, outside the pinned 6.4.6 version, and does not establish a patched package. No dependency downgrade or audit bypass was applied. The fixed offline toolchain therefore retains this known development/build-time dependency risk pending an upstream patched release or a reviewed compatible dependency update.

The live reliability run used local Ollama 0.33.3 with exact serving identity `llama3.2:3b`. FreeLLMAPI authenticated access was not tested because no valid credentials were available. No human ratings have been submitted, so the design-quality comparison remains unmeasured.

## Human review status

The original M1.3 blind package remains unchanged and has five complete pairs. It contains randomized A/B pipeline labels and independently randomized left/right positions. No reviewer JSON file has been submitted yet: unique prompts rated `0`, reviewers `0`, and judgments `0`. The user plans to review those five pairs. One reviewer can contribute 25 individual judgments: four candidate-scale ratings and one overall preference per prompt. Three independent reviewer files are still the target; no substitute or AI ratings were created.

## Next step

Collect the user's blind review JSON and two additional independent files, then report raw preference counts and per-prompt disagreements with the sample size visible. For a fresh generalization check, add an untouched prompt set in Milestone 1.5 before making design-quality claims. The same-corpus reliability result should not be used as the held-out result.
