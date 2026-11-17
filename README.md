# Design Intelligence — first runnable web prototype

An **early local-first vertical slice** of a design-system-aware prompt-to-UI product. Not yet a complete Design Intelligence Engine.

## What works now

- React + Vite web studio with web / mobile prototype project types
- Tech-stack intent (React + Vite or React Native + Expo); code export is **not** implemented yet
- Three design-system presets, editable colors/spacing/radii, import/export of JSON token subset
- FreeLLMAPI connection test and model discovery
- Real prompt-to-HTML/CSS generation via FreeLLMAPI with a curated design-skills prompt
- Versioned framework-neutral DesignSpec 1.0 validation and fixed-template React + TypeScript + Vite + Tailwind source export for web
- Isolated React typecheck/build and a separate static preview on supported Linux hosts; source ZIP export remains available everywhere
- Baseline and optimized runs, side-by-side previews, HTML exports, usage metadata
- Scriptless iframe preview with restricted resource policy

## Not implemented

- Expo code generation, builds, or export
- Evidence from a multi-reviewer design-quality study, automated repair, hosted authentication, desktop packaging
- Full DTCG import (aliases, modes, nested groups, complex tokens), imported component libraries

## Requirements

Node.js 22+ and npm. A **separate** running [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) instance configured with provider credentials and a unified key. React preview builds are supported on Linux with Bubblewrap user namespaces and a user systemd manager backed by cgroup v2 CPU, memory, and process controllers. Other hosts keep the source-only export.

## Run locally

```bash
npm install
npm ci --prefix apps/server/runner/toolchain --ignore-scripts
npm run dev
```

The second command prepares the fixed, pinned React build toolchain. It does not run during generation or build requests. If it is omitted, or if the Linux isolation prerequisites are unavailable, the studio reports source-only mode and ZIP export continues to work.

Open **http://127.0.0.1:5173**. In **Model settings**, enter the unified key from your local FreeLLMAPI instance. The app uses `http://127.0.0.1:3001/v1` by default. Set `FREELLMAPI_BASE_URL` in the environment before starting the app to use another gateway; the starter does not load `.env` files automatically. For example: `FREELLMAPI_BASE_URL=http://127.0.0.1:3100/v1 npm run dev`. The UI intentionally has no arbitrary gateway URL input.

The backend runs on **127.0.0.1:3002** and the web app on **127.0.0.1:5173**. The browser connects to it via Vite's local development proxy. If those ports are occupied, set `PORT` and `VITE_PORT` to free ports before `npm run dev`; for example, `PORT=3003 VITE_PORT=5174 npm run dev`. Neither the gateway key nor provider keys are saved in localStorage. Basic project metadata and design tokens are stored locally in the browser.

```bash
npm test
npm run typecheck
npm run build
npm run test:security-browser
npm run test --prefix benchmarks
```

`npm run typecheck` checks the React/TypeScript frontend. The backend is JavaScript and its build script runs Node's syntax checks for both server modules.

The browser security suite uses Playwright. Install browser binaries with `npx playwright install chromium firefox webkit`; Linux hosts may also need Playwright's documented OS libraries. Engines without their binaries or system dependencies skip explicitly. `npm run test:security-browser` starts a temporary local fixture server and does not contact FreeLLMAPI.

## FreeLLMAPI status

The backend expects a separately running OpenAI-compatible gateway at `http://127.0.0.1:3001/v1`. It calls `GET /models` for discovery and `POST /chat/completions` for generation, forwarding the unified key as a Bearer token from the backend. Override the base URL with `FREELLMAPI_BASE_URL` in the backend environment; the setting is server-side so browser clients cannot choose arbitrary gateway URLs. Automated route tests use a local mock gateway and need no credentials. Check **Model settings → Test connection & discover models** using the gateway's unified API key for a live authentication check. A reachable gateway alone does not confirm authentication, model discovery, or generation; those require a valid key and an available model/provider.

## React source export

Choose **React + Tailwind project** in the workspace to ask FreeLLMAPI for a DesignSpec 1.0 JSON document. The backend validates it, checks that its tokens and selected skills match the studio, then renders a fixed set of source files. The ZIP contains a pinned dependency manifest and a known script allowlist; model output cannot add files, packages, or commands. The schema can describe web or mobile experiences, but this source generator accepts web only.

On supported Linux hosts the backend compiles the fixed template in a disposable Bubblewrap user namespace with outbound networking disabled, a read-only toolchain, an ephemeral size-limited workspace, and systemd cgroup CPU, memory, and process limits. Builds do not execute generated package scripts or generated Vite/PostCSS/Tailwind configuration. Only validated hashed JavaScript and CSS assets are retained in memory and served by a separate local preview process. The iframe uses `sandbox="allow-scripts"` without same-origin, form, popup, or top-navigation permissions. Hosts without the verified runner continue to provide source-only ZIP export. The HTML prototype mode remains on its separate scriptless sanitizer/CSP path. See [docs/DESIGNSPEC.md](docs/DESIGNSPEC.md) and [docs/PREVIEW_SECURITY.md](docs/PREVIEW_SECURITY.md) for the security boundary and known limits.

## Security / deployment

This is intended for **trusted single-user local development** only, not a hosted multi-tenant deployment. The backend has no auth. Do not expose it to the internet. HTML output is sanitized and displayed in an iframe with `sandbox=""` and restrictive CSP. React output is built in an OS-isolated worker and run only in an opaque-origin browser iframe with a dedicated CSP; it remains untrusted code. The exported HTML and React project are prototypes, not security-reviewed applications. A hosted version requires authenticated sessions, per-user authorization and rate limits, SSRF protections, stronger isolation, quotas and browser-level security testing across supported engines.

See [docs/PREVIEW_SECURITY.md](docs/PREVIEW_SECURITY.md) for the sanitizer warning analysis, CSS filtering, CSP, and iframe containment decisions.

## Architecture

- `apps/web`: React studio
- `apps/server`: Fastify provider proxy and prompt/skill selector
- `docs/`: roadmap

Next milestone: collect the user's review and two additional independent reviews for the existing five M1.3 pairs, retain per-prompt disagreement, and add an untouched prompt set before making broader quality claims. M1.4's same-corpus retry result is technical reliability evidence only. Run the browser security suite in CI with Chromium, Firefox, and WebKit provisioned.

## Benchmark foundation

The standalone [`benchmarks`](benchmarks/README.md) package contains 10 version-controlled prompts and a deterministic fixture mode. It compares a raw DesignSpec-contract prompt with Dylani's existing skills + DesignSpec prompt, then uses the same pinned model, generation settings, React template, and isolated build path for both. Live inference supports the existing FreeLLMAPI-compatible gateway and explicitly selected loopback Ollama; it allows one same-model recovery attempt for invalid JSON or DesignSpec output and never switches models. Exact serving-model identity is required for a candidate to build. Run manifests preserve each attempt with configured credentials redacted and hash prompt and pipeline sources for reproducibility. The blind review package randomizes candidate labels and left/right order, supports individual reviewer ratings and ties, and keeps ratings unassigned until a human submits them. Fixture outputs do not measure design quality; see the benchmark README for reporting and limitations.
