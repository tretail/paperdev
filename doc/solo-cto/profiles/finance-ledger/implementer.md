
## Test baseline

As of 2026-11-01, `pnpm check` is already red on `main`, for reasons unrelated to your
task:

- Prettier flags `scripts/export-keobiz-recap.ts`.
- `pennylane-invoices`, `f5471`, `fr-statements` and `fec` test files fail with `ENOENT`,
  because they read exports from the gitignored `data/`, which you can't read.

So run `pnpm typecheck` and `pnpm test` separately, and compare with this list. Report
any new failure, and report these as not run; don't fix them unless that's your task. If
one of them passes, the list is out of date: say so in your report.
