# Next implementation milestones

1. **Browser security verification:** add browser-driven tests across supported engines for React preview execution, CSP enforcement, top-level navigation, and opaque-origin/cookie isolation.
2. **Evaluation:** add 390/768/1440px overflow checks and axe accessibility findings. Separate diagnostics from subjective aesthetics.
3. **Repair:** targeted one-pass fixes, re-run checks and keep the previous artifact if validation regresses.
4. **Benchmark:** same pinned model, 2-4 prompt treatments, blinded human preference; record usage, latency, actual served model and costs. Add cost-matched control.
5. **Desktop:** reuse React UI and core engine under Tauri with desktop-specific backend/worker strategy.
