# Next implementation milestones

1. **Code-generation contract:** generate a typed framework-neutral DesignSpec followed by validated React+Tailwind source. Keep Expo a UI prototype target until it has an actual build pipeline.
2. **Preview isolation:** compile generated source in disposable network-isolated workers with resource limits; inspect using Playwright.
3. **Evaluation:** add build failures, 390/768/1440px overflow checks and axe accessibility findings. Separate diagnostics from subjective aesthetics.
4. **Repair:** targeted one-pass fixes, re-run checks and keep the previous artifact if validation regresses.
5. **Benchmark:** same pinned model, 2-4 prompt treatments, blinded human preference; record usage, latency, actual served model and costs. Add cost-matched control.
6. **Desktop:** reuse React UI and core engine under Tauri with desktop-specific backend/worker strategy.
