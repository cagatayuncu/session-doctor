'use strict';
// Plain-text rendering of a diagnosis. Kept separate so the JSON stays the source of truth.

const path = require('path');
const { formatSpan, truncate, sum } = require('./util');

const STATE_ORDER = { hung: 0, 'orphan-cli': 1, stale: 2, unknown: 3, active: 4, self: 5 };

// Command lines, titles and paths come from the machine: never let them carry control characters.
function cellText(value) {
  // eslint-disable-next-line no-control-regex
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

function table(rows, columns) {
  if (rows.length === 0) return '  (none)';
  const cells = rows.map((row) => columns.map((c) => cellText(row[c])));
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (values) => `  ${values.map((v, i) => v.padEnd(widths[i])).join('  ')}`.trimEnd();
  return [line(columns), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

// Local wall-clock time, matching what the user sees in app logs: "2026-10-07 09:21".
function localTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function section(title) {
  return `\n== ${title} ==`;
}

function childSummary(children) {
  return Object.keys(children).sort().map((k) => `${k}:${children[k]}`).join(' ');
}

function sessionRows(sessions) {
  return [...sessions]
    .sort((a, b) => (STATE_ORDER[a.state] - STATE_ORDER[b.state]) || ((b.idleMinutes || 0) - (a.idleMinutes || 0)))
    .map((s) => ({
      State: s.state,
      Agent: s.agent,
      Pid: s.pid,
      Idle: formatSpan(s.idleMinutes),
      Age: formatSpan(s.ageHours * 60),
      Procs: s.procs,
      MB: s.mb,
      Children: truncate(childSummary(s.children), 34),
      Ports: s.ports.join(','),
      LastTool: truncate(s.subagent ? `${s.subagent}>${s.lastTool}` : s.lastTool, 28),
      Worktree: s.uncommitted ? `${s.uncommitted} uncommitted` : '',
      Session: truncate(s.title || (s.cwd && path.basename(s.cwd)) || s.command, 42),
    }));
}

function groupRows(groups) {
  return groups.map((g) => ({
    Category: g.category,
    Pid: g.pid,
    Role: g.role,
    Age: formatSpan(g.ageHours * 60),
    Procs: g.procs,
    MB: g.mb,
    Ports: g.ports.join(','),
    What: truncate(g.workload || g.command, 100),
  }));
}

function totals(groups) {
  return { groups: groups.length, procs: sum(groups, 'procs'), mb: sum(groups, 'mb'), pids: groups.map((g) => g.pid).join(',') };
}

// The thresholds and project of this report, so a pasted cleanup selects the same items.
function sameSettingsFlags(opts) {
  const flags = [`--stale-hours ${opts.staleHours}`, `--hung-minutes ${opts.hungMinutes}`, `--hook-max-minutes ${opts.hookMaxMinutes}`];
  if (opts.project) flags.push(`--project "${opts.project}"`);
  return flags.join(' ');
}

function suggestions(d, opts) {
  const base = `node "${opts.script}" cleanup`;
  const flags = sameSettingsFlags(opts);
  const safe = totals([...d.orphans.filter((g) => g.category === 'orphan-agent'), ...d.stuckHooks]);
  const tasks = totals(d.orphans.filter((g) => g.category === 'orphan-task'));
  const byState = (state) => totals(d.sessions.filter((s) => s.state === state));
  const confirm = [
    ['orphan-task', tasks, 'background jobs or servers whose launcher is gone'],
    ['orphan-cli', byState('orphan-cli'), 'agent CLIs whose launcher died'],
    ['hung', byState('hung'), 'interrupt the turn first if the app offers it; stop only if still hung'],
    ['stale', byState('stale'), 'idle sessions; ask which ones'],
  ];
  const lines = [];
  if (safe.groups) lines.push(`  SAFE    orphan-agent + stuck-hook: ${safe.groups} groups, ${safe.procs} procs, ${safe.mb} MB\n          ${base} --category orphan-agent,stuck-hook ${flags} --apply`);
  for (const [category, t, note] of confirm) {
    if (t.groups) lines.push(`  CONFIRM ${category} (${note}): ${t.groups} groups, ${t.procs} procs, ${t.mb} MB, PIDs ${t.pids}\n          ${base} --category ${category} --only <chosen pids> ${flags} --apply`);
  }
  return lines.length ? lines.join('\n') : '  Nothing to clean up.';
}

function hookLines(d, probes) {
  const out = ['  Hook processes started per tool call:', table(d.hotPath.map((r) => ({ Agent: r.agent, Tool: r.tool, Pre: r.pre, Post: r.post, Total: r.total })), ['Agent', 'Tool', 'Pre', 'Post', 'Total'])];
  const bySource = {};
  for (const h of d.hookConfig) if (/^(PreToolUse|PostToolUse|preToolUse|postToolUse)$/.test(h.event)) bySource[h.source] = (bySource[h.source] || 0) + 1;
  const sources = Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`);
  if (sources.length) out.push(`  Registered tool hooks by source: ${sources.join(', ')}`);
  for (const v of probes.disableVars || []) out.push(`  Note: ${v.name} lists ${v.count} hooks. Hooks disabled this way are still spawned; they just exit early.`);
  if (probes.spawn) out.push(`  Spawn cost now: node ${probes.spawn.nodeMs} ms, ${probes.spawn.shell || 'shell'} ${probes.spawn.shellMs} ms (each hook pays roughly shell + its interpreter).`);
  return out.join('\n');
}

function transcriptLines(summary, stats) {
  const out = [`  ${summary.totalGb} GB in ${summary.files} files. Largest:`,
    table(summary.largest.map((f) => ({ MB: f.mb, LastWrite: localTime(f.lastWrite), Project: truncate(f.project, 44), Id: f.id })), ['MB', 'LastWrite', 'Project', 'Id'])];
  if (!stats) return out.join('\n');
  out.push('  Hook output share in the most recently written transcripts:');
  out.push(table(stats.files.map((f) => ({ MB: f.mb, HookPercent: f.hookPercent, File: path.basename(f.file) })), ['MB', 'HookPercent', 'File']));
  out.push('  Slowest hooks in those transcripts (by total time):');
  out.push(table(stats.hooks.slice(0, 8).map((h) => ({ Hook: truncate(h.key, 60), n: h.n, p50Ms: h.p50Ms, p90Ms: h.p90Ms, totalSec: h.totalSec, errors: h.errors, cancelled: h.cancelled, timeouts: h.timeouts })), ['Hook', 'n', 'p50Ms', 'p90Ms', 'totalSec', 'errors', 'cancelled', 'timeouts']));
  out.push('  Hook latency per day (all hooks):');
  out.push(table(stats.daily.slice(-10).map((r) => ({ Day: r.day, n: r.n, p50Ms: r.p50Ms, p90Ms: r.p90Ms })), ['Day', 'n', 'p50Ms', 'p90Ms']));
  return out.join('\n');
}

function render(d, probes, opts) {
  const parts = [];
  parts.push(`Session doctor report ${localTime(d.generatedAt)} on ${d.platform} (this session's agent pid: ${d.selfCliPid || 'none'})`);
  parts.push(section('Machine'));
  parts.push(`  CPU ${d.load.cpuPercent}% of ${d.load.cores} logical cores, RAM ${d.load.memUsedPercent}% used (${d.load.memFreeGb} GB free of ${d.load.memTotalGb} GB)`);
  parts.push(section(`Agent CLI sessions (stale >= ${opts.staleHours}h idle, hung = busy with no conversation entry for ${opts.hungMinutes}m)`));
  parts.push(table(sessionRows(d.sessions), ['State', 'Agent', 'Pid', 'Idle', 'Age', 'Procs', 'MB', 'Children', 'Ports', 'LastTool', 'Worktree', 'Session']));
  parts.push(section('Orphaned processes (launcher is gone)'));
  if (d.portsKnown === false) parts.push('  Note: listening ports could not be read (no lsof/ss or no permission), so orphaned MCP/plugin servers are listed as orphan-task.');
  parts.push(table(groupRows(d.orphans), ['Category', 'Pid', 'Role', 'Age', 'Procs', 'MB', 'Ports', 'What']));
  parts.push(section(`Stuck hooks (started by an agent, older than ${opts.hookMaxMinutes}m and their configured timeout)`));
  parts.push(table(groupRows(d.stuckHooks), ['Category', 'Pid', 'Role', 'Age', 'Procs', 'MB', 'Ports', 'What']));
  parts.push(section('IDE hosts (MCP servers and agent CLIs running inside editors)'));
  parts.push(table(d.ideHosts.map((h) => ({ IDE: h.label, Windows: h.roots, MCP: h.mcp, MCP_MB: h.mcpMb, CLIs: h.clis, Hooks: h.hooks })), ['IDE', 'Windows', 'MCP', 'MCP_MB', 'CLIs', 'Hooks']));
  parts.push(section('Claude desktop terminal shells (Terminal panel)'));
  parts.push(d.terminals.length ? `  ${d.terminals.length} shells, ${sum(d.terminals, 'mb')} MB, oldest ${formatSpan(Math.max(...d.terminals.map((t) => t.ageHours)) * 60)}. Closed only by closing their tabs or restarting the app.` : '  (none)');
  parts.push(section('Hooks on the tool-call hot path'));
  parts.push(hookLines(d, probes));
  parts.push(section(`Claude desktop inactivity timeouts (last ${opts.timeoutHours}h)`));
  const timeouts = [...probes.timeouts].sort((a, b) => b.at - a.at).slice(0, 12);
  parts.push(table(timeouts.map((t) => ({ At: localTime(t.at), Session: t.hostSessionId, Seconds: t.seconds, LastTool: t.lastTool })), ['At', 'Session', 'Seconds', 'LastTool']));
  if (probes.transcripts) {
    parts.push(section('Claude transcripts'));
    parts.push(transcriptLines(probes.transcripts, probes.hookStats));
  }
  parts.push(section('Suggested actions'));
  parts.push(suggestions(d, opts));
  return parts.join('\n');
}

module.exports = { table, localTime, render };
