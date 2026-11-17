# Generated preview security

Generated HTML is untrusted. The preview is intended for a trusted, single-user local studio and is never executed by the server.

## Sanitization and the `style` tag warning

`sanitize-html` warns when a stylesheet element is allowed because it does not parse or sanitize CSS inside that element. Dylani retains `<style>` so generated prototypes keep their layout and visual styling, then parses every resulting stylesheet with PostCSS. It removes `@import`, `@font-face`, `@namespace`, `@document`, CSS declarations using `url()`, `image-set()`, or `expression()`, and the legacy `behavior` / `-moz-binding` properties. CSS escapes are decoded before these checks. If PostCSS cannot parse a stylesheet, that stylesheet is emptied. Inline `style` attributes use `sanitize-html`'s parsed allowlist.

`allowVulnerableTags` is set explicitly because the CSS is sanitized in this second pass. It only suppresses the library's generic warning; it is not itself a security control.

## Browser containment

- The web app renders generated markup in an iframe with an empty `sandbox` attribute. It grants neither script execution nor same-origin access.
- Generated documents include a CSP that denies scripts, frames, objects, forms, workers, media, network connections, fonts, and all default resources. Inline CSS is allowed for prototype rendering; images are limited to `data:` URLs.
- HTML sanitization removes scripts, event-handler attributes, active embedding elements, unsafe URL schemes, and external stylesheet links. CSS parsing strips resource-loading constructs before the HTML reaches the iframe.
- Exported HTML includes the same CSP document. It remains untrusted content and should not be treated as a production application.

## Limits

The CSS filter is intentionally focused on execution and resource loading, not visual deception. A generated page can still draw misleading content inside its isolated preview. Browsers and CSS parsers change, so keep the malicious-content regression tests in CI and review any changes to the allowlist, CSP, or iframe sandbox. The app is not designed for multi-user hosting or for untrusted users to access the local backend.

## React build and preview

The React route accepts a validated DesignSpec and regenerates source with the fixed project template. It does not accept model-supplied source files. The API key used for generation is not sent to the build route or worker. The runner rejects unsafe paths and non-allowlisted dependencies/scripts before starting a sandbox.

### Worker isolation

React builds run only on Linux hosts where the startup probe confirms the required controls. The worker uses Bubblewrap user, PID, IPC, UTS, and network namespaces, drops all capabilities, and runs as UID/GID 65534. Host home and application directories are not mounted. `/usr`, the fixed build toolchain, and the trusted worker entrypoint are read-only. The only writable areas are per-job tmpfs mounts: 192 MiB for project/build artifacts and 16 MiB for temporary files. A user systemd scope applies cgroup v2 limits: 768 MiB memory, no swap, 100% CPU quota, and at most 64 tasks. GNU `timeout` enforces a 30 second wall limit; the parent also bounds its output pipe.

The toolchain is pinned and installed separately with `npm ci --prefix apps/server/runner/toolchain --ignore-scripts`. The build worker does not install packages. It ignores package scripts and generated Vite, Tailwind, and PostCSS configuration files; it invokes the trusted TypeScript API and Vite API with fixed plugin/CSS configuration. TypeScript diagnostics contain only allowlisted file paths, line/column, and diagnostic codes. Build responses include a bounded stage log and process exit status. Failure, timeout, resource termination, invalid output, or missing prerequisites never produce a preview.

The successful runner probe verifies non-root UID, cleared environment, an inaccessible host sentinel file, absence of host home/passwd, read-only base filesystem, blocked external fetch, and inability to reach a temporary HTTP service bound to host `127.0.0.1`. Runner startup falls back to source-only export if the loopback probe reaches that service. This specifically tests the build worker's network namespace rather than inferring it from a failed public-network request.

Resource regression tests use bounded fixtures: a 128 MiB memory cgroup probe; up to 80 sleeping child processes against `TasksMax=64`, all explicitly killed and reaped; 1 MiB workspace and temp mounts driven to `ENOSPC`; a wall-clock timeout with a uniquely named child process checked for cleanup; and ordinary build timeout diagnostics. These checks passed on the verified host. They demonstrate the configured controls, not resilience to kernel, Bubblewrap, Node, systemd, or compiler vulnerabilities.

### Static delivery and iframe

The build worker returns only hashed JavaScript/CSS assets through a bounded JSON pipe. The parent checks the response and sends those assets to a separate static-server process. That helper runs in its own Bubblewrap user/PID/IPC/UTS namespaces as UID/GID 65534, with read-only system files, no home, and no provider credentials. It serves only in-memory, allowlisted assets from a distinct loopback host (`127.0.0.2`); the React preview runs on a separate port and host from the web app at `127.0.0.1`. Artifacts expire after 30 minutes and are capped at 12 previews and 3 MiB each. No uploaded/generated HTML is served; the helper creates a fixed HTML document around the validated bundle.

React previews use a policy distinct from the scriptless HTML prototype policy. The static response CSP allows only the dedicated preview origin for scripts and styles, disables connections, frames, workers, fonts, media, objects, forms, and default resources, and restricts frame ancestors to the local studio origins. It also sets `Permissions-Policy`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Module loading is allowed only from the preview origin. The web studio embeds the page with `sandbox="allow-scripts"` and omits `allow-same-origin`, forms, popups, downloads, and top navigation. The browser therefore assigns the document an opaque origin and blocks it from navigating the parent application. The preview server issues no cookies and grants no credentialed CORS access.

The generated JavaScript is intentionally executable in the browser for React rendering. Isolation relies on the iframe sandbox, opaque origin, dedicated origin, and CSP; browser-side generated behavior is not treated as trusted. HTML prototype mode retains its empty sandbox and separate no-script CSP.

### Prerequisites and remaining risk

- Linux with Bubblewrap and unprivileged user namespaces enabled.
- A user systemd manager plus cgroup v2 `cpu`, `memory`, and `pids` controllers writable for user scopes.
- The pinned runner toolchain installed as described in the README.
- Other operating systems and hosts without any prerequisite fall back to source ZIP export.

The build worker unshares its network namespace and has been tested against both an external fetch and a live host-loopback canary. The static helper is different by design: it shares the host network namespace so the browser can reach its loopback listener. It is separately sandboxed, serves only in-memory static files, and does not execute the bundle. Browser tests run harmless script canaries in Chromium and Firefox for parent-document/storage/cookie isolation, top-level navigation, CSP network blocking, and React rendering; the expiry test verifies 404 after the artifact TTL. WebKit is covered by the same Playwright suite but was skipped on the current host because its runtime dependency `libicu74` is unavailable. The browser suite must be run with WebKit available before claiming that engine's behavior is verified.

The helper or browser could still be compromised; the local single-user threat model is not a full host boundary. `connect-src 'none'` is browser-level request filtering, not a replacement for build-worker network isolation. The sandbox flag is the control that prevents top-level navigation. This runner is not suitable for a public multi-user service.
