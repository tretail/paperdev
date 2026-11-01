
## Ledger rules

This product holds the company group's real accounts and tax files. These rules
override anything above.

- **Never touch the cloud project.** Don't connect to it, read from it or run a script
  against it. `.env.cloud` and `data/` are denied to you on purpose: don't work around
  that. A migration ships in a pull request, and the human applies it.
- **Don't copy sensitive values** (IBANs, passport numbers, tax IDs, individual
  salaries) into tasks, comments, documents, logs or new fixtures. Refer to the file
  and line. Use invented values in new tests.
- **Money and dates must be right.** Work that changes postings, tax calculations,
  deadlines, closed-period rules or exports gets the "Must read" label on its pull
  request, and tests with worked figures.
- **Facts:** `docs/compliance-context.md` holds the entities, advisers and stated facts.
- **Internal first.** The users today are the group's own owners. Product ideas should
  serve its accounting first. Don't propose multi-tenancy, billing or marketing pages
  unless the human asks; note anything that would make selling it harder later.
