'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lib } = require('./helpers');

const { analyzeFiles, shortHookCommand, percentile } = lib('hook-stats');
const { parseTimeoutLines } = lib('probes');
const { table, render, localTime } = lib('report');

function hookLine(type, extra) {
  return JSON.stringify({
    type: 'attachment',
    timestamp: '2026-10-06T10:00:00.000Z',
    attachment: { type, hookEvent: 'PostToolUse', command: 'node "C:\\u\\.pixel-agents\\hooks\\claude-hook.js"', ...extra },
  });
}

test('hook statistics: latency, failures and transcript share', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-stats-')), 't.jsonl');
  fs.writeFileSync(file, `${[
    JSON.stringify({ type: 'user', message: { content: 'x'.repeat(200) } }),
    hookLine('hook_success', { durationMs: 300, exitCode: 0 }),
    hookLine('hook_success', { durationMs: 6000, exitCode: 0 }),
    hookLine('hook_non_blocking_error', { durationMs: 900, exitCode: 1, stderr: 'spawnSync bash.exe ETIMEDOUT' }),
    hookLine('hook_cancelled', {}),
    'not json',
  ].join('\n')}\n`);
  const out = await analyzeFiles([file]);
  const [hook] = out.hooks;
  assert.strictEqual(out.hooks.length, 1);
  assert.strictEqual(hook.key, 'PostToolUse hooks/claude-hook.js');
  assert.strictEqual(hook.n, 4);
  assert.strictEqual(hook.p50Ms, 900);
  assert.strictEqual(hook.errors, 1);
  assert.strictEqual(hook.timeouts, 1);
  assert.strictEqual(hook.cancelled, 1);
  assert.ok(out.files[0].hookPercent > 50);
  assert.deepStrictEqual(out.daily.map((d) => d.day), ['2026-10-06']);
});

test('hook-stats helpers', () => {
  assert.strictEqual(shortHookCommand('node -e "x" node scripts/hooks/pre-bash.js'), 'hooks/pre-bash.js');
  assert.strictEqual(percentile([1, 2, 3, 4], 0.5), 3);
  assert.strictEqual(percentile([], 0.5), 0);
});

test('desktop timeout lines', () => {
  const log = [
    '2026-10-06 13:40:54 [warn] [CCD] Session local_af6c timed out after 1007s of inactivity (hadFirstResponse=true, last_tool_name=Write, x=y)',
    '2026-10-06 13:41:57 [info] Resuming session local_af6c in C:\\x',
    '2026-09-01 10:00:00 [warn] [CCD] Session old timed out after 999s of inactivity (last_tool_name=Read)',
  ].join('\n');
  const rows = parseTimeoutLines(log, new Date(2026, 9, 5).getTime());
  assert.deepStrictEqual(rows.map((r) => [r.hostSessionId, r.seconds, r.lastTool]), [['local_af6c', 1007, 'Write']]);
});

function session(state, extra = {}) {
  return {
    state, category: state, agent: 'claude', pid: 1000 + Object.keys(extra).length, idleMinutes: 900, ageHours: 30, procs: 3, mb: 300,
    children: { mcp: 2 }, ports: [], lastTool: 'Read', subagent: '', title: `${state} session`, cwd: '', command: 'claude', ...extra,
  };
}

test('render shows every section and the suggested commands', () => {
  const now = Date.now();
  const d = {
    generatedAt: now, platform: 'linux', selfCliPid: 500,
    load: { cpuPercent: 40, cores: 8, memUsedPercent: 80, memFreeGb: 3, memTotalGb: 16 },
    sessions: [session('self', { pid: 500 }), session('hung', { pid: 30824, subagent: 'code-reviewer' }), session('stale', { pid: 17264, uncommitted: 11 })],
    orphans: [
      { category: 'orphan-agent', pid: 300, role: 'hook', ageHours: 3, procs: 1, mb: 44, ports: [], command: 'node hook.js', workload: '' },
      { category: 'orphan-task', pid: 310, role: 'dev-server', ageHours: 48, procs: 7, mb: 210, ports: [5173], command: 'pnpm dev', workload: 'vite' },
    ],
    stuckHooks: [],
    terminals: [{ pid: 130, ageHours: 100, mb: 77 }],
    ideHosts: [{ label: 'Cursor', roots: 1, mcp: 3, mcpMb: 150, clis: 1, hooks: 0 }],
    hotPath: [{ agent: 'claude', tool: 'Edit', pre: 7, post: 11, total: 18 }],
    hookConfig: [{ source: 'claude:plugin:x', event: 'PostToolUse' }],
  };
  const probes = {
    timeouts: [{ at: now, hostSessionId: 'local_1', seconds: 1007, lastTool: 'Write' }],
    disableVars: [{ name: 'X_DISABLED_HOOKS', count: 12 }],
    spawn: { nodeMs: 180, shellMs: 320, shell: 'bash.exe' },
    transcripts: { totalGb: 7.8, files: 1121, largest: [{ mb: 533, lastWrite: now, project: 'p', id: 'i' }], recent: [] },
    hookStats: { files: [{ file: '/x/t.jsonl', mb: 9.9, hookPercent: 82 }], hooks: [{ key: 'PostToolUse hooks/a.js', n: 494, p50Ms: 5162, p90Ms: 7871, totalSec: 2487, errors: 0, cancelled: 0, timeouts: 0 }], daily: [{ day: '2026-10-06', n: 10, p50Ms: 5758, p90Ms: 8272 }] },
  };
  d.sessions[2].title = 'evil\u001b[2Jtitle';
  d.portsKnown = false;
  const text = render(d, probes, { staleHours: 6, hungMinutes: 30, hookMaxMinutes: 10, timeoutHours: 48, project: '/p', script: '/s/session-doctor.js' });
  for (const heading of ['Machine', 'Agent CLI sessions', 'Orphaned processes', 'Stuck hooks', 'IDE hosts', 'terminal shells', 'hot path', 'inactivity timeouts', 'Claude transcripts', 'Suggested actions']) {
    assert.ok(text.includes(heading), `has section ${heading}`);
  }
  assert.match(text, /code-reviewer>Read/);
  assert.match(text, /11 uncommitted/);
  assert.match(text, /SAFE {4}orphan-agent \+ stuck-hook: 1 groups, 1 procs, 44 MB\n {10}node "\/s\/session-doctor\.js" cleanup --category orphan-agent,stuck-hook --stale-hours 6 --hung-minutes 30 --hook-max-minutes 10 --project "\/p" --apply/);
  assert.match(text, /CONFIRM orphan-task .*PIDs 310\n.*--category orphan-task --only <chosen pids> --stale-hours 6/);
  assert.match(text, /CONFIRM hung .*PIDs 30824/);
  assert.match(text, /CONFIRM stale .*1 groups/);
  assert.match(text, /X_DISABLED_HOOKS lists 12 hooks/);
  assert.match(text, /listening ports could not be read/);
  assert.ok(!text.includes('\u001b'), 'control characters are stripped');
  assert.match(text, /evil\?\[2Jtitle/);
  const row = (state) => text.search(new RegExp(`^  ${state} `, 'm'));
  assert.ok(row('hung') > 0 && row('hung') < row('stale') && row('stale') < row('self'), 'hung first, self last');
});

test('render with nothing to clean', () => {
  const d = { generatedAt: 0, platform: 'darwin', selfCliPid: 0, load: { cpuPercent: 1, cores: 1, memUsedPercent: 1, memFreeGb: 1, memTotalGb: 2 }, sessions: [], orphans: [], stuckHooks: [], terminals: [], ideHosts: [], hotPath: [], hookConfig: [] };
  const text = render(d, { timeouts: [], disableVars: [], spawn: null, transcripts: null, hookStats: null }, { staleHours: 12, hungMinutes: 30, hookMaxMinutes: 10, timeoutHours: 48, script: 'x' });
  assert.match(text, /Nothing to clean up\./);
});

test('localTime is local wall-clock time', () => {
  assert.strictEqual(localTime(new Date(2026, 9, 7, 9, 5).getTime()), '2026-10-07 09:05');
});

test('table pads columns and handles empty input', () => {
  assert.strictEqual(table([], ['A']), '  (none)');
  const lines = table([{ A: 'x', B: 'long value' }], ['A', 'B']).split('\n');
  assert.strictEqual(lines[0], '  A  B');
  assert.strictEqual(lines[2], '  x  long value');
});
