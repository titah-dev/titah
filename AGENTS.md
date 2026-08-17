# AGENTS.md

Read by Titah, Claude Code, and other agent CLIs at the start of every turn.
Everything here is paid for on every request, so it holds only what is not
already visible in the code.

## What this is

Titah — a coding agent that runs in the terminal and can call other agents.
TypeScript, ESM, Node ≥ 22.6, no bundler. AI SDK v7 for models, Ink 7 + React 19
for the TUI, `node:sqlite` for storage, HTTP + SSE between client and server.

## Commands

- Build: `npm run build` — plain `tsc`, output in `dist/`
- Test: `npm test` — **builds first**, then `node --test test/*.test.ts`
- Typecheck: `npm run typecheck`
- Run from source: `npm run dev`

Two things about the test command that cost time when discovered the hard way.
It builds first because some tests import from `dist/`, not `src/` — a TUI
change with no rebuild is tested against the previous version and passes for the
wrong reason. And `rm -rf dist` drops the executable bit on `dist/cli.js`, so a
clean rebuild needs `chmod +x dist/cli.js` before the binary works again.

## Language

**UI strings in English. Code comments in Bahasa Indonesia.** Both, always —
this is a Bahasa-Indonesia-speaking codebase that ships an English product.
Model replies follow whatever language the user wrote in; that is the model's
job, not the code's.

## TypeScript

`erasableSyntaxOnly` is on. No parameter properties, no `enum`, no namespaces —
anything that needs more than deleting the types is rejected at compile time.

## Comments

Comments explain **why**, never what. The what is in the line below them.

The ones worth writing are the ones that stop a future reader from "simplifying"
something load-bearing: why a value is frozen at turn start rather than read
live, why a check sits after a branch instead of before it, why a list is
deliberately not sorted. If a comment could be deleted without any decision
becoming harder to understand, it should be.

## Tests

Every test name states the behaviour, not the function. A body that needed a
judgement call carries the reasoning above it — including the measurement that
motivated it, where one exists.

Pin behaviour that is easy to break invisibly. This repo keeps hitting one bug
class in particular: **what is measured is not what is sent.** A viewport that
counted rows it did not draw, a model computed twice from two expressions, a
permission explained by one code path and enforced by another. When a value is
derived in two places, assume they will drift and write the test that catches it.

## Rules

- Never claim a test passed without running it and showing the output. If it
  fails, say so with the output. If a step was skipped, say that.
- Verify against the real thing. CLI flags get checked against the installed
  binary, not recalled from documentation.
- Do not commit or push unless asked. Branch first if on `main`.
- Measure before and after for anything that changes behaviour under a model —
  prompt wording, delegation, permissions. Reasoning about what a model will do
  is not evidence of what it does.
