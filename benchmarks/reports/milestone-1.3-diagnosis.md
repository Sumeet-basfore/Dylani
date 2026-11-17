# Milestone 1.3 reliability diagnosis

This report analyzes the immutable run `2026-11-17T15-59-33-413Z-11faa07f-7a54-418b-a186-683a47740410`. The source artifacts and manifest were read only. The model was Ollama `llama3.2:3b` through Ollama `0.33.3`, using the native `/api/chat` endpoint with `think:false` and a JSON Schema `format`.

## Failure classification

All six invalid candidates were valid JSON and declared DesignSpec `1.0`. Each failed the same `designSpecSchema` refinement: **component and child IDs must be unique across the entire hierarchy**. No other schema issues were reported for these six responses.

| Prompt | Variant | Validation cause |
|---|---|---|
| `saas-01-operations-dashboard` | Baseline | Child ID `text` repeated twice across sections |
| `saas-03-subscription-health` | Optimized | Child ID `label` repeated three times |
| `landing-01-finance-product` | Optimized | Child IDs `text` repeated twice and `metric` repeated three times |
| `landing-03-climate-reporting` | Baseline | Child ID `text` repeated six times |
| `landing-03-climate-reporting` | Optimized | Child ID `text` repeated twice |
| `portfolio-02-frontend-engineer` | Baseline | Child ID `text` repeated five times and `button` repeated twice |

The shared failure pattern is reuse of generic child IDs (`text`, `label`, `metric`, `button`) across separate sections. Both variants failed on `landing-03-climate-reporting` for repeated `text` IDs. Each variant had three failures out of ten, so observed DesignSpec validity was 7/10 for both. This is a technical validity result, not evidence of design-quality improvement.

## Prompt-level comparison

| Prompt | Baseline | Optimized | Complete pair |
|---|---|---|---|
| SaaS operations dashboard | Failed: duplicate `text` | Valid | No |
| SaaS support analytics | Valid | Valid | Yes |
| SaaS subscription health | Valid | Failed: duplicate `label` | No |
| Finance product landing page | Valid | Failed: duplicate `text`, `metric` | No |
| Team planning landing page | Valid | Valid | Yes |
| Climate reporting landing page | Failed: duplicate `text` | Failed: duplicate `text` | No |
| Product designer portfolio | Valid | Valid | Yes |
| Frontend engineer portfolio | Failed: duplicate `text`, `button` | Valid | No |
| Home goods commerce | Valid | Valid | Yes |
| Outdoor gear commerce | Valid | Valid | Yes |

There are five complete A/B pairs. The blind review directory has randomized candidate identity and left/right order. No reviewer rating files are present: reviewers `0`, rated prompts `0`, judgments `0`. Human evaluation remains incomplete.

## Structured-output implication

Ollama's [structured outputs documentation](https://docs.ollama.com/capabilities/structured-outputs), checked on 2026-11-17, documents passing a JSON Schema object in the local `/api/chat` `format` field and recommends validating the parsed result. It says Ollama Cloud does not currently support structured outputs. The loopback local run accepted the format field and returned parseable objects with the expected structural fields. The uniqueness rule is implemented as a Zod `superRefine` spanning IDs in multiple arrays. That global semantic condition is not represented by the generated JSON Schema, so schema-constrained decoding alone cannot guarantee it. Every candidate was still checked by the DesignSpec validator before build.

Milestone 1.4 adds one bounded recovery attempt for malformed JSON or DesignSpec validation failures. It uses the same rule and request budget for both variants, retains every attempt, and requires the pinned model identity on every accepted response. The follow-up reliability run is diagnostic on this same prompt corpus and is not an independent held-out quality evaluation. A fresh untouched prompt set is needed for generalization claims.
