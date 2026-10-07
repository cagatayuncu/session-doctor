# session-doctor

An agent skill that finds and safely stops leaked or stuck AI-agent processes, and
measures the hook overhead that makes every tool call slow. It works with Claude Code
(CLI, desktop app, IDE extension) and Cursor, and also inventories other agent CLIs
(codex, gemini, opencode, copilot). Runs on Windows, macOS and Linux. Node.js 18+, no
dependencies.

## What it finds

| Problem | Example |
|---|---|
| Sessions left open for days | 20 idle Claude desktop sessions, each with its own copy of every MCP server |
| Hung sessions and subagents | Busy for hours, last tool `code-reviewer>Read`, no progress |
| Orphaned agent processes | Hook and MCP processes whose launcher died (Windows never kills children with their parent) |
| Background jobs left behind | `vite`, `quasar dev` or test runners from a session that is long gone, still holding a port |
| Hook overhead | 18 hook processes per edit; per-day hook latency from 0.3 s to 6 s; 70-90 % of transcripts is hook output |
| Desktop app symptoms | `timed out after 1000s of inactivity`, dozens of Terminal-panel shells |

The skill classifies each finding into a tier:
- **safe**: orphaned hooks and MCP processes, stuck hooks
- **confirm**: stale or hung sessions, orphaned jobs
- **config**: hot-path hooks
- **user**: restarting an app

The agent then applies only what each tier allows.

## Install

### Claude Code

```text
/plugin marketplace add cagatayuncu/session-doctor
/plugin install session-doctor@session-doctor
```

Or from a shell: `claude plugin marketplace add cagatayuncu/session-doctor` and
`claude plugin install session-doctor@session-doctor`.

### Cursor

In Cursor, open **Customize → Plugins → From GitHub Repository** and paste
`https://github.com/cagatayuncu/session-doctor`. Teams can also add it under
**Dashboard → Plugins & MCPs → Add Marketplace → Import from Repo**.

### Any agent that reads skill folders (manual)

Cursor loads skills from `~/.cursor/skills`, `~/.agents/skills` and `~/.claude/skills`;
Claude Code loads them from `~/.claude/skills`. Clone the repository and link the skill
folder into one of those directories.

macOS / Linux:

```bash
git clone https://github.com/cagatayuncu/session-doctor ~/src/session-doctor
ln -s ~/src/session-doctor/plugins/session-doctor/skills/session-doctor ~/.claude/skills/session-doctor
```

Windows (PowerShell):

```powershell
git clone https://github.com/cagatayuncu/session-doctor $HOME\src\session-doctor
New-Item -ItemType Junction -Path "$HOME\.claude\skills\session-doctor" -Target "$HOME\src\session-doctor\plugins\session-doctor\skills\session-doctor"
```

## Use

Ask your agent, for example: *"Claude is slow and tool calls hang, run session doctor."*
The skill runs a read-only diagnosis and explains it. It then cleans up only what you
approve.

You can also run it yourself:

```bash
node plugins/session-doctor/skills/session-doctor/scripts/session-doctor.js diagnose
node plugins/session-doctor/skills/session-doctor/scripts/session-doctor.js cleanup --category orphan-agent,stuck-hook
node plugins/session-doctor/skills/session-doctor/scripts/session-doctor.js cleanup --category orphan-agent,stuck-hook --apply
```

## Safety

- `diagnose` only reads. `cleanup` is a dry run unless `--apply` is given.
- Processes are never stopped by name. Each group is re-classified from a fresh process
  snapshot. Each PID's start time is checked right before stopping it, so a PID the OS
  reused for another program is skipped.
- The session running the tool is never a target, and neither are its ancestors.
  Desktop/IDE apps and OS shell processes (explorer, launchd, systemd, terminals, tmux)
  are never stopped either, even when they appear inside a session's process tree.
- A hook only counts as stuck when an agent started it and it outlived its configured
  timeout. A command that merely looks like a hook is left alone.
- Stale/hung sessions, orphaned jobs, loosely matched hooks and anything orphaned that
  listens on a port need explicit confirmation.
- Reports and the action log live in `~/.session-doctor/` (user-private).
- Transcripts, session registries and worktrees are never deleted.

## Limitations

- Activity is precise for Claude Code (session registry plus transcript tails). For
  `cursor-agent` it is precise only when the process was started with `--resume <id>`.
  For other CLIs it is coarse: launcher gone, or a print-mode run older than the stale
  window.
- Cursor's in-IDE agent chats are not inventoried. Their MCP servers and hook processes
  are counted under the IDE.
- Hook latency statistics come from Claude Code transcripts.

## Development

```bash
npm test          # node --test, synthetic process trees + a read-only run on this machine
```

| Path | Role |
|---|---|
| `plugins/session-doctor/skills/session-doctor/SKILL.md` | The skill: workflow and safety tiers for the agent |
| `.../scripts/session-doctor.js` | CLI: `diagnose`, `cleanup` |
| `.../scripts/lib/platform.js` | Process snapshot, ports, load, stopping (Windows CIM, `ps`, `lsof`/`ss`) |
| `.../scripts/lib/roles.js`, `tree.js`, `classify.js` | What a process is, the tree, the categories |
| `.../scripts/lib/sessions.js`, `hooks.js` | Agent activity sources, Claude Code and Cursor hook config |
| `.claude-plugin/`, `.cursor-plugin/` | Marketplace manifests for Claude Code and Cursor |
| `tests/` | `node:test` suites |

CI runs the tests on Windows, macOS and Ubuntu. To support another agent CLI, add a row
to `AGENT_CLIS` in `roles.js`. If the agent has a session store, also add an activity
source in `sessions.js`.

## License

MIT
