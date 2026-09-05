# AI Runtime Architecture

## Core Principles

1. Runtime knowledge source

- Runtime knowledge may come only from:
  - `skills/`
  - real code, tool results, and project data
- `docs/`, `assets/`, and `ai-metadata/` are not runtime knowledge sources.

2. Responsibility split

- `web` collects real context and executes validated canvas plans.
- `hono-api` injects hard constraints only:
  - permissions
  - output protocol
  - factuality
  - explicit failure
  - audit/trace
- The native Agent in `apps/agents` (`@tapcanvas/agents`) performs:
  - intent recognition
  - evidence planning
  - skill loading
  - subagent delegation
  - result synthesis

3. Skills vs prompt

- SOP, creative methods, workflow heuristics, and prompting methods belong in `skills/`.
- System prompts must not hard-code route logic, workflow SOPs, or fixed subagent order.

4. Failure policy

- Missing evidence must fail explicitly.
- No silent fallback.
- No fabricated progress or fabricated project state.

## Current Migration Direction

- `apps/agents` is the only default Agent runtime and the only runtime that new
  product work should target. It owns the native Harness Web UI, sessions,
  Agent loop, Skills, subagents, and TapCanvas tool registration.
- The migrated TapCanvas skills are versioned under
  `apps/agents/.agents/skills/tapcanvas-*` and are discovered by the native
  runtime's project skill provider. The copies under `apps/agents-cli/skills/`
  remain only as legacy migration source and are not the current skill root.
- `apps/agents-cli` is legacy migration and diagnostic code. It is not started
  by the default entrypoint and must not be treated as the current execution
  path.
- Remove runtime guidance that points agents to `docs/assets/ai-metadata`.
- Keep `hono-api` prompt minimal and structural.
- Move TapCanvas workflow methods into dedicated runtime skills.
