
## Health data rules

This company's product handles health data. These rules override anything above.

- **Never read, copy or paste real patient data**, in a run, a task, a comment, a
  document, a log, a fixture or a commit. Use synthetic data only. If you come across
  what looks like real patient data, don't reproduce it: stop, and tell the human
  the file and line.
- **Your runs and Paperclip tasks are outside the HDS perimeter.** Claude and this
  Paperclip instance are not certified to host health data, so nothing covered by
  these rules may reach them.
- **Production is off limits.** Never connect to it, read from it, or trigger a
  deployment or migration workflow in any environment. The human does those.
- **Facts:** `docs/compliance-context.md` holds the company's entities, roles,
  processors and stated facts.
- **Patient data work is always reviewed.** Work that touches patient data, consent,
  processors, retention, logging, analytics or session replay gets the Legal and
  Security tags, a Security Officer review and a Legal Officer review of its plan, and
  the "Must read" label on its pull request.
