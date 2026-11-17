# Design Intelligence — first runnable web prototype

An **early local-first vertical slice** of a design-system-aware prompt-to-UI product. Not yet a complete Design Intelligence Engine.

## What works now

- React + Vite web studio with web / mobile prototype project types
- Tech-stack intent (React + Vite or React Native + Expo); code export is **not** implemented yet
- Three design-system presets, editable colors/spacing/radii, import/export of JSON token subset
- FreeLLMAPI connection test and model discovery
- Real prompt-to-HTML/CSS generation via FreeLLMAPI with a curated design-skills prompt
- Baseline and optimized runs, side-by-side previews, HTML exports, usage metadata
- Scriptless iframe preview with restricted resource policy

## Not implemented

- React or React Native code generation, builds, or export
- Visual evaluation / automated layout checks / targeted repair
- Model-agnostic adapter tests, reproducible benchmarks, hosted authentication, desktop packaging
- Full DTCG import (aliases, modes, nested groups, complex tokens), imported component libraries

## Requirements

Node.js 22+ and npm. A **separate** running [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) instance configured with provider credentials and a unified key.

## Run locally

```bash
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. In **Model settings**, enter the unified key from your local FreeLLMAPI instance. The app uses `http://127.0.0.1:3001/v1` by default. Change this server-side with `FREELLMAPI_BASE_URL` if needed. The UI intentionally has no arbitrary gateway URL input.

The backend runs on **127.0.0.1:3002**. The browser connects to it via Vite's local development proxy. Neither the gateway key nor provider keys are saved in localStorage. Basic project metadata and design tokens are stored locally in the browser.

```bash
npm test
npm run build
```

## Security / deployment

This is intended for **trusted single-user local development** only, not a hosted multi-tenant deployment. The backend has no auth. Do not expose it to the internet. Model output is sanitized and displayed in an iframe with `sandbox=""` and restrictive CSP; it is still untrusted code/content. The exported HTML is a prototype, not a security-reviewed application. Do not add `allow-scripts` or server-side execution of generated content. A hosted version requires authenticated sessions, per-user authorization and rate limits, SSRF protections, isolation, quotas and stronger HTML/CSS validation.

## Architecture

- `apps/web`: React studio
- `apps/server`: Fastify provider proxy and prompt/skill selector
- `docs/`: roadmap

Next milestone: strict React/Tailwind code generation into a fixed project template, compilation in disposable network-isolated workers, and Playwright screenshots.
