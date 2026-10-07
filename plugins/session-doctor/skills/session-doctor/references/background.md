# Background: why agent machines get slow, and how to read the report

## Process model

```
Claude desktop app (Claude.exe / Claude.app)          IDE (Cursor, VS Code, Windsurf)          terminal / orchestrator / script
 ├─ renderers, utilities (--type=...)                  ├─ extension host                         └─ claude / cursor-agent / codex / gemini ...
 ├─ Terminal-panel shell, one per session tab          │   ├─ MCP servers (one copy per window)
 └─ claude --output-format stream-json ...             │   └─ claude (Claude Code extension)
     one CLI process per opened session                └─ agent terminals
     ├─ MCP servers: cmd/sh -> npx -> node <mcp>.js
     ├─ tool shells: bash -c "source shell-snapshots/... && eval '<cmd>'"   (incl. background jobs)
     └─ hooks: <shell> -c "<hook command>" -> node/python <hook>, started per event
```

- The Claude desktop app keeps one CLI process alive for every session opened since the
  app started, idle or not, along with that session's MCP servers. Twenty sessions mean
  twenty copies of every MCP server. IDEs do the same per window.
- Subagents (Claude Code's `Agent` tool) run inside their parent's CLI process. A hung
  subagent shows up as a `hung` parent, and the report names it (`code-reviewer>Read`),
  read from `<session>/subagents/*.meta.json`.
- **Windows does not kill children with their parent.** When an agent times out a hook or
  ends a shell, only the outer shell dies; the `node` inside becomes an orphan. Hooks
  that wait on stdin never exit.
- **macOS/Linux re-parent orphans to launchd/systemd.** The report treats that parent as
  "launcher gone". A stdio MCP server usually exits on its own when its client dies, so
  on Unix most leaks are stale sessions, not orphans.

## The failure mode (the vicious circle)

1. Every hook on the tool-call hot path starts a shell plus an interpreter on every tool
   call. With 10-18 hooks per edit, that is 20-36 process starts per edit.
2. Leaked sessions, MCP copies and orphans keep CPU and RAM busy, so each start gets
   slower. A hook that took 0.3 s takes 5-6 s.
3. Slow hooks hit their timeout. The agent kills the shell, the interpreter leaks, and
   load goes up again.
4. The Claude desktop app ends a session after about 1000 s without output
   (`timed out after Ns of inactivity` in its `main.log`). Long reviews and subagents die
   mid-task.
5. Claude Code stores hook output in the transcript. 65-90 % of a transcript can be hook
   output, so files reach hundreds of MB and sessions open slowly.

Fixing it takes both: remove the leaks (Tier A/B) and reduce hot-path hooks (Tier C).
Doing only one lets the cycle come back.

## Reading the signals

| Signal (report section) | Healthy | Problem |
|---|---|---|
| Hook latency per day, p50 | < 0.5 s | > 1 s, and rising over the days |
| Hook processes per tool call (edit/write) | 0-4 | 10+ |
| Spawn cost, shell + node | < 300 ms | > 1 s (the machine is overloaded) |
| Stale sessions / MCP copies | a few | dozens, several GB |
| Claude desktop inactivity timeouts (48 h) | 0 | several, `LastTool` = Write/Edit/Read |
| Hook share of recent transcripts | < 20 % | 60 %+ |
| Claude desktop Terminal-panel shells | a few | 40+ (closing tabs or an app restart helps) |

## How activity is measured

- **Claude Code**: `~/.claude/sessions/<pid>.json` (written by the CLI) gives session id,
  cwd, status (`busy`/`idle`), title, `hostSessionId` (the desktop session id) and the
  process start time. Entries left by an earlier process with the same PID are ignored.
  A transcript's mtime is **not** activity, because apps append bookkeeping lines
  (artifact ledgers, titles) to idle transcripts. Only the timestamps of
  `user`/`assistant`/`system`/`attachment` entries in the transcript tail count.
- **Cursor CLI** (`cursor-agent`): the `store.db` mtime of `~/.cursor/chats/*/<chat-id>/`
  when the process was started with `--resume <chat-id>`. Without one it is `unknown`,
  unless it is a print-mode run older than the stale window.
- **Other agent CLIs**: no activity source. Only `orphan-cli` (launcher gone) and old
  print-mode runs are flagged automatically; everything else is `unknown`.
- **PID reuse**: a parent created after its child is a different process, so the child
  counts as orphaned. `cleanup` re-checks each process start time right before it stops
  the process.

## Stopping a session is reversible

When a session's CLI process is gone, the Claude desktop app marks the session stopped
and resumes it from the transcript on the next message (`Resuming session ... in <cwd>`
in `main.log`). Terminal sessions resume with `claude --resume` / `cursor-agent --resume`.
The conversation is kept. In-memory state is lost: running background jobs, MCP
connections, an unfinished turn.
