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
development. Three local Claude Code agents share one Claude subscription:

- `tech-lead` — read-only. Runs a daily technical discovery (CI, DX,
  security, design, debt) and proposes at most three tasks for you to accept.
- `product-lead` — read-only. Runs a daily product discovery (user friction,
  domain features, growth) with web research, proposes at most three tasks,
  and writes product specs for you to approve before technical planning.
- `planner` — read-only. Investigates a task and writes its `plan` document,
  then asks you to approve that exact plan revision.
- `implementer` — writes code only after you approved the current plan
  revision. Works on a task branch, runs tests, pushes the branch, and opens
  a pull request. It never pushes to or merges the default branch.

After import, finish setup as described in `doc/SOLO-CTO-WORKFLOW.md`: point
the `app` project at your repository and enable its plan approval policy with
`implementer` as the implementer.
