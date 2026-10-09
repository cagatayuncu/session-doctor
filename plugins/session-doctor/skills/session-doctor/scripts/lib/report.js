'use strict';
// Plain-language text report. The JSON (diagnosis.json / --json) stays the full detail;
// this view leads with a summary, lists sessions by project and says what can be freed.

const { truncate, sum } = require('./util');
const { summarize } = require('./summary');

const MB_PER_GB = 1024;
const TITLE_WIDTH = 46;
const LABEL_WIDTH = 16;

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

function size(mb) {
  return mb >= MB_PER_GB ? `${(mb / MB_PER_GB).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// "20m", "3h 10m", "9h", "2d 4h"
function span(minutes) {
  if (minutes == null) return '?';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 3) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function sessionLabel(s) {
  switch (s.tier) {
    case 'this': return '● this session';
    case 'working': return '● working';
    case 'recent': return `◐ idle ${span(s.idleMinutes)}`;
    case 'idle': return `○ idle ${span(s.idleMinutes)}`;
    case 'stale': return `○ idle ${span(s.idleMinutes ?? s.ageHours * 60)}`;
    case 'hung': return `⚠ hung ${span(s.idleMinutes)}`;
    case 'orphan-cli': return '✕ orphaned';
    default: return '? no activity info';
  }
}

function sessionNotes(s) {
  const notes = [];
  if (s.tier === 'stale') notes.push('stale');
  if (s.tier === 'hung' && s.lastTool) notes.push(`stuck in ${s.subagent ? `${s.subagent} > ` : ''}${s.lastTool}`);
  if (s.tier === 'orphan-cli') notes.push('its launcher is gone');
  if (s.where) notes.push(s.where);
  if (s.uncommitted) notes.push(`${s.uncommitted} uncommitted files`);
  if (s.ports && s.ports.length) notes.push(`port ${s.ports.join(',')}`);
  if (s.agent !== 'claude') notes.push(s.agent);
  return notes;
}

function sessionLine(s) {
  const title = truncate(s.title || s.command || '(untitled)', TITLE_WIDTH).padEnd(TITLE_WIDTH);
  const mcp = s.children && s.children.mcp ? `${s.children.mcp} MCP` : '';
  const notes = sessionNotes(s);
  const parts = [sessionLabel(s).padEnd(LABEL_WIDTH), title, size(s.mb).padStart(7), mcp.padEnd(6), `pid ${s.pid}`];
  return `    ${parts.join('  ')}${notes.length ? `  · ${notes.join(' · ')}` : ''}`.trimEnd();
}

function tierSentence(tiers, staleHours) {
  const parts = [];
  if (tiers.working) parts.push(`${tiers.working} working`);
  if (tiers.recent) parts.push(`${tiers.recent} active in the last hour`);
  if (tiers.idle) parts.push(`${tiers.idle} idle for hours`);
  if (tiers.stale) parts.push(`${tiers.stale} stale (idle ${staleHours}h+)`);
  if (tiers.hung) parts.push(`${tiers.hung} hung`);
  if (tiers['orphan-cli']) parts.push(`${tiers['orphan-cli']} orphaned`);
  if (tiers.unknown) parts.push(`${tiers.unknown} without activity info`);
  return parts.length ? `${parts.join(', ')}.` : '';
}

function worstHook(d) {
  const claude = d.hotPath.filter((r) => r.agent === 'claude').sort((a, b) => b.total - a.total)[0];
  return claude && claude.total > 0 ? claude : null;
}

function overview(d, s, probes, opts) {
  const lines = [];
  const others = s.sessions.count - (s.tiers.this || 0);
  lines.push(`${plural(s.sessions.count, 'agent session')} open${s.tiers.this ? ` (this one included)` : ''}, using ${size(s.sessions.mb)} with ${plural(s.sessions.mcp, 'MCP server process', 'MCP server processes')}.`);
  if (others > 0) lines.push(tierSentence(s.tiers, opts.staleHours));
  lines.push(d.orphans.length || d.stuckHooks.length
    ? `${plural(d.orphans.length + d.stuckHooks.length, 'leaked process group')} (${size(sum(d.orphans, 'mb') + sum(d.stuckHooks, 'mb'))}) left behind by agents.`
    : 'No leaked agent processes.');
  lines.push(`Machine: CPU ${d.load.cpuPercent}% of ${d.load.cores} cores, RAM ${d.load.memUsedPercent}% used (${d.load.memFreeGb} GB free).`);
  const hook = worstHook(d);
  const today = probes.hookStats && probes.hookStats.daily.length ? probes.hookStats.daily[probes.hookStats.daily.length - 1] : null;
  if (hook) lines.push(`Hooks: every ${hook.tool} starts ${plural(hook.total, 'hook process', 'hook processes')}${today ? `; a hook takes ${(today.p50Ms / 1000).toFixed(1)} s (median, ${today.day})` : ''}.`);
  return lines.filter(Boolean).map((l) => `  ${l}`).join('\n');
}

function sessionsSection(s) {
  if (s.groups.length === 0) return null;
  const lines = ['Open sessions by project'];
  for (const group of s.groups) {
    lines.push(`  ${cellText(group.name)}  (${plural(group.sessions.length, 'session')}, ${size(group.mb)})`);
    for (const session of group.sessions) lines.push(cellText(sessionLine(session)));
  }
  return lines.join('\n');
}

// The thresholds and project of this report, so a pasted cleanup selects the same items.
function sameSettingsFlags(opts) {
  const flags = [`--stale-hours ${opts.staleHours}`, `--hung-minutes ${opts.hungMinutes}`, `--hook-max-minutes ${opts.hookMaxMinutes}`];
  if (opts.project) flags.push(`--project "${opts.project}"`);
  return flags.join(' ');
}

function cleanupSection(d, s, opts) {
  const base = `node "${opts.script}" cleanup`;
  const flags = sameSettingsFlags(opts);
  const lines = ['What can be cleaned up'];
  if (s.safe.count) {
    lines.push(`  Safe now: ${plural(s.safe.count, 'leaked agent process group')} (${size(s.safe.mb)}, ${plural(s.safe.procs, 'process', 'processes')}).`);
    lines.push(`    ${base} --category orphan-agent,stuck-hook ${flags} --apply`);
  }
  const choices = [
    ['orphan-task', s.orphanTasks, 'background job or server', 'background jobs or servers', 'its launcher is gone; it may still be in use'],
    ['hung', s.candidates.hung, 'hung session', 'hung sessions', 'interrupt the turn first if the app can'],
    ['orphan-cli', s.candidates['orphan-cli'], 'orphaned agent CLI', 'orphaned agent CLIs', 'its launcher is gone'],
    ['stale', s.candidates.stale, 'stale session', 'stale sessions', `idle ${opts.staleHours}h+`],
  ];
  for (const [category, t, one, many, note] of choices) {
    if (!t.count) continue;
    lines.push(`  Your choice: ${plural(t.count, one, many)} (${note}): ${size(t.mb)}, ${plural(t.procs, 'process', 'processes')}, pids ${t.pids.join(',')}.`);
    lines.push(`    ${base} --category ${category} --only <chosen pids> ${flags} --apply`);
  }
  if (s.reclaim.count) {
    lines.push(`  Closing all of the above frees about ${size(s.reclaim.mb)} and ${plural(s.reclaim.procs, 'process', 'processes')}. Conversations stay on disk and can be resumed.`);
  } else {
    lines.push('  Nothing needs cleaning up right now.');
    if (s.tiers.idle) lines.push(`  ${plural(s.tiers.idle, 'session')} idle for hours, under the ${opts.staleHours}h stale mark; diagnose --stale-hours <n> lists them as stale.`);
  }
  return lines.join('\n');
}

function groupLine(g) {
  const what = cellText(truncate(g.workload || g.command, 80));
  const tier = g.category === 'orphan-task' ? 'your choice' : 'safe';
  const ports = g.ports.length ? ` · port ${g.ports.join(',')}` : '';
  return `  ✕ ${g.role.padEnd(12)} ${what}\n      ${tier} · ${span(g.ageHours * 60)} old · ${size(g.mb)} · ${plural(g.procs, 'process', 'processes')}${ports} · pid ${g.pid}`;
}

function leakSection(d) {
  const groups = [...d.orphans, ...d.stuckHooks];
  if (groups.length === 0) return null;
  const lines = ['Leaked processes (their launcher is gone, or a hook outlived its timeout)'];
  if (d.portsKnown === false) lines.push('  Note: listening ports could not be read (no lsof/ss or no permission), so orphaned MCP/plugin servers need your choice.');
  return [...lines, ...groups.map(groupLine)].join('\n');
}

function ideSection(d) {
  if (d.ideHosts.length === 0) return null;
  return ['Inside editors', ...d.ideHosts.map((h) => `  ${h.label}: ${plural(h.roots, 'window process', 'window processes')}, ${plural(h.mcp, 'MCP server')} (${size(h.mcpMb)}), ${plural(h.clis, 'agent CLI')}, ${plural(h.hooks, 'hook process', 'hook processes')}`)].join('\n');
}

function desktopSection(d, probes, opts) {
  const lines = [];
  if (d.terminals.length) {
    lines.push(`  ${plural(d.terminals.length, 'Terminal-panel shell')} (${size(sum(d.terminals, 'mb'))}, oldest ${span(Math.max(...d.terminals.map((t) => t.ageHours)) * 60)}); closing their tabs or restarting the app frees them.`);
  }
  if (probes.timeouts.length) {
    const last = [...probes.timeouts].sort((a, b) => b.at - a.at)[0];
    lines.push(`  ${plural(probes.timeouts.length, 'session')} timed out for inactivity in the last ${opts.timeoutHours}h (latest ${localTime(last.at)}, last tool ${last.lastTool}).`);
  }
  return lines.length ? ['Claude desktop app', ...lines].join('\n') : null;
}

function hooksSection(d, probes) {
  const lines = ['Hook overhead'];
  for (const agent of ['claude', 'cursor']) {
    const rows = d.hotPath.filter((r) => r.agent === agent);
    if (rows.length) lines.push(`  ${agent === 'claude' ? 'Claude Code' : 'Cursor'}: ${rows.map((r) => `${r.tool} ${r.total}`).join(' · ')} hook processes per call`);
  }
  const bySource = {};
  for (const h of d.hookConfig) if (/^(pre|post)ToolUse$/i.test(h.event)) bySource[h.source] = (bySource[h.source] || 0) + 1;
  const sources = Object.entries(bySource).sort((a, b) => b[1] - a[1]).map(([src, n]) => `${src} ${n}`);
  if (sources.length) lines.push(`  Registered by: ${sources.join(', ')}`);
  for (const v of probes.disableVars || []) lines.push(`  ${v.name} lists ${v.count} hooks; hooks disabled that way are still started, they only exit early.`);
  if (probes.spawn) lines.push(`  Starting a process costs ${probes.spawn.nodeMs} ms (node) and ${probes.spawn.shellMs} ms (${probes.spawn.shell || 'shell'}) right now.`);
  const stats = probes.hookStats;
  if (stats && stats.daily.length) lines.push(`  Median hook time per day: ${stats.daily.slice(-6).map((r) => `${r.day.slice(5)} ${(r.p50Ms / 1000).toFixed(1)} s`).join(' · ')}`);
  if (stats && stats.hooks.length) lines.push(`  Slowest: ${stats.hooks.slice(0, 4).map((h) => `${cellText(h.key.split(' ').pop())} ${(h.p50Ms / 1000).toFixed(1)} s × ${h.n}`).join(', ')}`);
  return lines.length > 1 ? lines.join('\n') : null;
}

function transcriptSection(probes) {
  const t = probes.transcripts;
  if (!t) return null;
  const lines = [`Claude transcripts: ${t.totalGb} GB in ${plural(t.files, 'file')}`];
  const shares = probes.hookStats ? probes.hookStats.files.map((f) => f.hookPercent).filter((p) => p != null) : [];
  if (shares.length) lines.push(`  Recent transcripts are ${Math.min(...shares)}-${Math.max(...shares)}% hook output.`);
  if (t.largest.length) lines.push(`  Largest: ${t.largest.slice(0, 3).map((f) => `${cellText(f.project)} ${f.mb} MB`).join(', ')}`);
  return lines.join('\n');
}

function render(d, probes, opts) {
  const s = summarize(d);
  const header = `Session doctor · ${localTime(d.generatedAt)} · ${d.platform}`;
  return [
    `${header}\n${overview(d, s, probes, opts)}`,
    sessionsSection(s),
    cleanupSection(d, s, opts),
    leakSection(d),
    ideSection(d),
    desktopSection(d, probes, opts),
    hooksSection(d, probes),
    transcriptSection(probes),
  ].filter(Boolean).join('\n\n');
}

module.exports = { table, localTime, size, span, render, sessionLine };
