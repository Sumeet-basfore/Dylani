# DesignSpec 1.0 and React source export

## Contract

`@dylani/design-spec` defines the versioned Zod schema and inferred TypeScript type. The specification stays framework-neutral. It contains:

- `schemaVersion`, target `platform`, and a semantic `pageType`;
- user requirements, a layout kind and density, validated design tokens, and responsive behavior;
- a shallow component tree: named sections with typed text, button, metric, input, list, or badge children;
- selected design-skill IDs.

Objects are strict at every level. IDs must be unique kebab-case identifiers, token colors and dimensions have bounded formats, strings and arrays have limits, and unknown fields or schema versions fail validation. `POST /api/design-spec/validate` returns either `{valid:true,schemaVersion:"1.0"}` or HTTP 422 with safe path/message details. The route never returns rejected input values.

The existing `/api/generate` HTML prototype route remains separate. `POST /api/generate-react` requests a framework-neutral JSON spec from the existing FreeLLMAPI adapter, validates it, requires the active design tokens and skill selection to match, then passes the validated data to the deterministic template generator. Invalid JSON returns HTTP 502; a schema or studio-contract mismatch returns HTTP 422.

## Fixed web project template

The generator creates an exact file allowlist for React + TypeScript + Vite + Tailwind. Text from the spec is stored as escaped TypeScript data and rendered as React text; it is never inserted as raw HTML. Layout and responsive classes come from fixed maps. The generated manifest pins React, its TypeScript definitions, Vite, TypeScript, and Tailwind dependencies; scripts are fixed to `dev`, `build`, and `preview`. Validation rejects traversal/absolute paths, duplicate or missing files, oversized contents, unexpected packages, and altered commands. No model-produced file paths, dependencies, plugins, or shell commands are accepted.

The frontend packages the validated file list as a ZIP. The app does not persist generated sources in browser storage.

## Isolated build boundary

On Linux, `POST /api/build-react` validates the submitted DesignSpec, regenerates the project from the fixed template, then sends its files to a Bubblewrap worker. The worker runs as UID/GID 65534 in user, PID, IPC, UTS, and network namespaces. It has no host home or app directory, no application credential environment, a read-only `/usr` and pinned toolchain, and only 192 MiB workspace and 16 MiB temporary tmpfs mounts. A user systemd scope applies cgroup v2 limits of 768 MiB memory, no swap, one CPU, and 64 tasks. GNU `timeout` enforces a 30 second wall limit; the output channel is bounded and accepts only hashed JavaScript/CSS assets. No package manager, generated shell command, package script, or generated Vite/PostCSS/Tailwind config is executed. Vite and the TypeScript compiler are invoked through trusted APIs with fixed configuration.

Runner availability is checked at runtime. If Bubblewrap namespaces, user systemd/cgroup controllers, the prepared toolchain, or the security probes fail, React generation remains source-only and ZIP export still works. The runner is currently supported only on Linux hosts meeting those prerequisites. See [PREVIEW_SECURITY.md](PREVIEW_SECURITY.md) for the static delivery and iframe boundary.

## Known limits

- The React target currently supports web only. The schema can describe mobile, but no mobile compiler exists.
- DesignSpec is shallow by design and covers a small set of semantic sections/elements; it is not a general component library format.
- Source generation is deterministic and template-driven. It does not allow arbitrary model-authored React or CSS.
- React build output is compiled in the isolated runner; browser behavior is untrusted and remains subject to CSP/iframe controls.
- The preview-serving helper shares the host network namespace so the browser can reach its loopback address; it runs in a separate Bubblewrap user namespace with a read-only filesystem and receives no provider key.
- Source exports remain usable on unsupported hosts. User-run builds are outside Dylani's trust boundary.
