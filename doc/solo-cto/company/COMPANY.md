---
name: Solo CTO Workspace
description: One developer supervising Claude Code agents with a human plan-approval gate before any implementation.
slug: solo-cto-workspace
schema: agentcompanies/v1
version: 1.0.0
goals:
  - Ship reliable software for the products in this company's projects
---

# Solo CTO Workspace

A minimal company for a single developer who supervises AI-assisted
development. Seven local Claude Code agents share one Claude subscription;
all but the Implementer are read-only:

- `investigator`: takes every task you create (in Backlog), challenges it from
  the business, product, tech, security and legal angles, asks the leads for
  a review where relevant and you for answers, tags it, and parks it in
  Backlog for the Planner.
- `tech-lead`: daily technical discovery (bugs, tests, CI, DX, design, debt),
  a weekly code-health pass, and technical reviews.
- `product-lead`: daily product discovery (user friction, domain features,
  growth) with web research, product reviews, and specs when you ask.
- `security-officer`: weekly security audit and reviews of plans that touch
  security.
- `legal-officer`: weekly legal audit (GDPR, cookies, terms, consumer law; the
  regimes are listed per company) and reviews of plans that touch personal
  data or legal obligations.
- `planner`: writes a task's `plan` document when you drag it to Todo, gets
  officer reviews where needed, then asks you to approve that exact revision.
- `implementer`: writes code only after you approved the current plan
  revision. Works on a task branch, runs tests, pushes the branch, and opens
  a pull request. It never pushes to or merges the default branch.

Discovery and audits propose at most three tasks; the weekly audits propose
none when there is nothing to fix. Accepted proposals get a review from the
other lead and wait in Backlog: dragging a card to Todo is what starts work.

After import, finish setup as described in `doc/SOLO-CTO-WORKFLOW.md`: point
the `app` project at your repository, enable its plan approval policy with
`implementer` as the implementer, set its intake agent to `investigator`, and
create the Product, Tech, Security, Legal and Infra labels.
