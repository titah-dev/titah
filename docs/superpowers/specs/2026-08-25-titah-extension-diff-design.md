# titah-extension-diff — Design Spec

**Date:** 2026-08-25
**Status:** Approved for implementation

---

## 1. Purpose

A right-side panel extension for Titah that shows diffs in two tabs:
- **Git Diff** — unified diff from `git diff HEAD` (unstaged) and `git diff --cached` (staged)
- **Session Changes** — in-memory tracked files modified during the current Titah session, shown as unified diffs against session start

---

## 2. Architecture

### Components (new files only)

| File | Responsibility |
|------|----------------|
| `src/git-diff.ts` | Run `git diff` commands, parse unified diff output into view rows |
| `src/session-tracker.ts` | In-memory map of `filepath → { originalContent, currentContent }` |
| `src/tabs.ts` | Tab state machine, layout budget, cursor per tab |
| `src/panel.ts` | Extension factory — orchestrates tabs, handles render/onKey/onClick |
| `src/index.ts` | Default export factory |

### Data Flow

```
render({signal, width, rows})
  → if git repo: run git diff HEAD + git diff --cached in parallel (with signal)
  → get session diffs from sessionTracker.getAllDiffs()
  → tabs.buildView(activeTab, gitDiffRows, sessionDiffRows, width, budget)
  → return View { kind: "rows", rows: [...] }
```

---

## 3. Tab Behavior

- **Tab / Shift+Tab**: cycle between "Git Diff" ↔ "Session Changes"
- **Each tab has independent cursor** (like git extension's per-section cursors)
- **Refresh triggers**: prompt sent, turn ends, panel opened, `r` key
- **Empty states**: "clean" (git), "no session changes" (session)

---

## 4. Session Tracking (In-Memory Only)

```
sessionTracker.recordWrite(filepath, newContent)  // called via hook/event from Titah
sessionTracker.getDiff(filepath) → unified diff string
sessionTracker.getAllDiffs() → Map<filepath, diffString>
```

For v1, the tracker is initialized empty. Hook integration for actual session tracking can be added later.

---

## 5. Package Config

```json
{
  "name": "@titah/extension-diff",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22.6", "titah": "^0.4.0" },
  "titah": { "panel": "./dist/panel.js" },
  "scripts": { "build": "tsc", "typecheck": "tsc --noEmit", "test": "npm run build && node --test test/*.test.ts" }
}
```

---

## 6. Options (User-Configurable)

```ts
interface Options {
  gitDiffLimit?: number     // max diff lines (default: 200)
  contextLines?: number     // git diff -U (default: 3)
  showWhitespace?: boolean  // --ignore-space-change (default: false)
}
```

---

## 7. View Primitives

Uses only `View` types from `titah-code/extension`:
- `{ kind: "rows", rows: ViewRow[] }` — for diff lines
- `{ kind: "text", text: string }` — for empty states

No JSX, no React dependencies.

---

## 7. Error Handling

- Not a git repo → "not a git repo" (dim)
- Git command fails → show error row, don't crash panel
- `AbortSignal` respected for all subprocesses
- Session tracker never throws — returns empty diff if file not tracked

---

## 8. Testing

- Unit tests for `git-diff.ts` (parse unified diff)
- Unit tests for `session-tracker.ts` (record/get diff)
- Unit tests for `tabs.ts` (layout, cursor clamping)
- Integration test: panel renders without error in git repo and non-git dir