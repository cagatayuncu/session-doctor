'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lib, proc, NOW, HOUR } = require('./helpers');

const { buildContext, orphanGroups, stuckHookGroups, sessionInventory, desktopTerminals, ideHosts, selectTargets, orphanCategory } = lib('classify');

const DESKTOP = 'C:\\Program Files\\WindowsApps\\Claude_2.1_x64__abc\\app\\Claude.exe';
const CLI = 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.284\\claude.exe --output-format stream-json';
const ORCH = 'C:/Tools/orchestrator/bin/daemon/orch.exe';
const HOOKS = [
  { agent: 'claude', source: 'claude:user', event: 'Stop', matcher: '', command: `"${ORCH}" hook stop`, pluginRoot: '' },
  { agent: 'claude', source: 'claude:user', event: 'Stop', matcher: '', command: 'node "C:\\Users\\u\\.pixel-agents\\hooks\\claude-hook.js"', pluginRoot: '' },
];

function machine() {
  return [
    proc(1, 0, 'explorer.exe', 'explorer.exe', 300),
    proc(100, 1, 'claude.exe', DESKTOP, 200),
    proc(200, 100, 'claude.exe', CLI, 150, 300),
    proc(201, 200, 'cmd.exe', 'cmd.exe /d /s /c "npx -y chrome-devtools-mcp@latest"', 150, 6),
    proc(400, 200, 'bash.exe', `bash.exe -c "${ORCH} hook stop"`, 0.5, 7),
    proc(500, 100, 'claude.exe', CLI, 2, 300),
    proc(501, 500, 'pwsh.exe', 'pwsh.exe -NoProfile -Command "$__claudeCodeScript = 1"', 0.1, 90),
    proc(502, 500, 'orch.exe', `${ORCH} mcp`, 2, 30),
    proc(130, 100, 'pwsh.exe', 'pwsh.exe', 100, 77),
    proc(300, 999, 'node.exe', 'node.exe C:\\Users\\u\\.pixel-agents\\hooks\\claude-hook.js', 3, 44),
    proc(310, 998, 'bash.exe', 'bash.exe -c "source /c/u/.claude/shell-snapshots/snapshot-bash-1.sh && eval \'python -m app.main\' < /dev/null"', 22, 8),
    proc(311, 310, 'python.exe', 'python.exe -m app.main', 22, 104),
    proc(320, 997, 'bash.exe', 'bash.exe -c "source /c/u/.claude/shell-snapshots/snapshot-bash-2.sh"', 48, 8),
    proc(321, 320, 'bash.exe', 'bash.exe -c "sleep 1"', 48, 8),
    proc(330, 996, 'cmd.exe', 'cmd.exe /C "C:\\Program Files\\AMD\\AMDRSServ.exe"', 150, 3),
    proc(340, 341, 'node.exe', 'node C:\\Repos\\web\\node_modules\\vite\\bin\\vite.js', 48, 64),
    proc(341, 1, 'notepad.exe', 'notepad.exe', 1, 5),
    proc(350, 995, 'claude.exe', 'C:\\Users\\u\\.local\\bin\\claude.exe --session-id 11111111-2222-4333-8444-555555555555', 70, 250),
    proc(360, 994, 'node.exe', 'node remote-mcp-server.js --port 8931', 5, 40),
    // The user's own terminal: explorer never has a live parent, its tree must stay untouched.
    proc(600, 1, 'WindowsTerminal.exe', 'WindowsTerminal.exe', 100, 80),
    proc(601, 600, 'pwsh.exe', 'pwsh.exe', 100, 70),
    proc(602, 601, 'node.exe', 'node C:\\Repos\\app\\node_modules\\vite\\bin\\vite.js', 10, 90),
    // An orphaned MCP tree containing a never-stop process is refused as a whole.
    proc(700, 993, 'node.exe', 'node chrome-devtools-mcp.js', 5, 40),
    proc(701, 700, 'explorer.exe', 'explorer.exe /factory', 5, 40),
    // Cursor IDE with an MCP server per window.
    proc(800, 1, 'Cursor.exe', 'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe', 50, 400),
    proc(801, 800, 'Cursor.exe', 'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe --type=utility', 50, 300),
    proc(802, 801, 'node.exe', 'node some-mcp-server.js', 50, 60),
  ];
}

function ctxWith(overrides = {}) {
  return buildContext({
    processes: machine(), hookConfig: HOOKS, selfPid: 501, now: NOW,
    ports: new Map([[311, [8765]], [360, [8931]]]), ...overrides,
  });
}

function byPid(groups) {
  return new Map(groups.map((g) => [g.pid, g]));
}

test('orphan classification', async (t) => {
  const groups = byPid(orphanGroups(ctxWith()));
  await t.test('an orphaned hook is safe to stop', () => assert.strictEqual(groups.get(300).category, 'orphan-agent'));
  await t.test('an orphaned tool shell with only shells under it is safe', () => assert.strictEqual(groups.get(320).category, 'orphan-agent'));
  await t.test('a background job left by a dead session needs confirmation', () => {
    const g = groups.get(310);
    assert.strictEqual(g.category, 'orphan-task');
    assert.strictEqual(g.procs, 2);
    assert.deepStrictEqual(g.ports, [8765]);
    assert.match(g.workload, /python\.exe -m app\.main/);
  });
  await t.test('an orphan whose parent PID was reused is still found', () => assert.strictEqual(groups.get(340).category, 'orphan-task'));
  await t.test('an MCP server that serves a port needs confirmation', () => assert.strictEqual(groups.get(360).category, 'orphan-task'));
  await t.test('unrelated orphans are ignored', () => assert.ok(!groups.has(330)));
  await t.test('explorer is never claimed, even with a dev server below it', () => {
    assert.ok(!groups.has(1));
    assert.ok(!groups.has(602));
  });
  await t.test('groups containing a never-stop process are refused', () => assert.ok(!groups.has(700)));
  await t.test('CLI processes are left to the session inventory', () => assert.ok(!groups.has(350)));
});

test('orphans that might be run on purpose need confirmation', () => {
  assert.strictEqual(orphanCategory('mcp', ['mcp'], { reparented: true }), 'orphan-task');
  assert.strictEqual(orphanCategory('mcp', ['mcp'], {}), 'orphan-agent');
  assert.strictEqual(orphanCategory('mcp', ['mcp'], { portsKnown: false }), 'orphan-task', 'ports unreadable');
  assert.strictEqual(orphanCategory('hook', ['hook'], { servesPorts: true }), 'orphan-task', 'a hook worker that listens');
  assert.strictEqual(orphanCategory('hook', ['hook'], { reparented: true }), 'orphan-task');
  assert.strictEqual(orphanCategory('hook', ['hook'], { looseHook: true }), 'orphan-task', 'only loosely matched');
  assert.strictEqual(orphanCategory('hook', ['hook'], {}), 'orphan-agent');
});

test('a loosely matched orphaned hook needs confirmation', () => {
  const ctx = buildContext({
    processes: [proc(900, 991, 'node', 'node scripts/lint.js --watch', 2)],
    hookConfig: [{ agent: 'claude', event: 'PostToolUse', matcher: '', command: 'node $CLAUDE_PROJECT_DIR/scripts/lint.js', pluginRoot: '' }],
    now: NOW,
  });
  assert.strictEqual(orphanGroups(ctx)[0].category, 'orphan-task');
});

test('stuck hooks', async (t) => {
  await t.test('hooks younger than the limit are ignored', () => {
    assert.strictEqual(stuckHookGroups(ctxWith({ hookMaxMinutes: 45 })).length, 0);
  });
  await t.test('a hook that outlived the limit under its agent is reported', () => {
    const stuck = stuckHookGroups(ctxWith({ hookMaxMinutes: 20 }));
    assert.deepStrictEqual(stuck.map((g) => g.pid), [400]);
  });
  await t.test('a configured hook timeout raises the limit', () => {
    const hookConfig = HOOKS.map((h) => ({ ...h, timeout: 3600 }));
    assert.strictEqual(stuckHookGroups(ctxWith({ hookMaxMinutes: 20, hookConfig })).length, 0);
  });
  await t.test('a matching command the user started is not a stuck hook', () => {
    const hookConfig = [{ agent: 'claude', event: 'PostToolUse', matcher: '', command: 'npm run test', pluginRoot: '' }];
    const processes = [
      proc(1, 0, 'explorer.exe', 'explorer.exe', 300),
      proc(10, 1, 'zsh', '-zsh', 5),
      proc(11, 10, 'npm', 'npm run test', 1),
      proc(20, 1, 'claude', '/Users/u/.local/bin/claude', 5),
      proc(21, 20, 'bash', 'bash -c "source /u/.claude/shell-snapshots/snapshot-zsh-1.sh && eval \'npm run test\' < /dev/null"', 1),
      proc(22, 21, 'npm', 'npm run test', 1),
      proc(30, 20, 'sh', '/bin/sh -c npm run test', 1),
    ];
    const stuck = stuckHookGroups(buildContext({ processes, hookConfig, now: NOW, hookMaxMinutes: 10 }));
    assert.deepStrictEqual(stuck.map((g) => g.pid), [30], 'only the one the agent ran as a hook');
  });
});

test('session inventory', async (t) => {
  const created200 = NOW - 150 * HOUR;
  const fileTime = String((BigInt(created200) + 11644473600000n) * 10000n);
  const registry = new Map([
    [200, { pid: 200, sessionId: 's-200', status: 'idle', name: 'Old work', cwd: 'C:\\Repos\\x', updatedAt: NOW - 20 * HOUR, procStart: fileTime }],
    [500, { pid: 500, sessionId: 's-500', status: 'busy', updatedAt: NOW }],
  ]);
  const sessions = byPid(sessionInventory(ctxWith({ registry })));
  await t.test('a long idle registered session is stale', () => assert.strictEqual(sessions.get(200).state, 'stale'));
  await t.test('idle time comes from the registry', () => assert.strictEqual(sessions.get(200).idleMinutes, 1200));
  await t.test('children are counted by role', () => {
    assert.deepStrictEqual(sessions.get(200).children, { mcp: 1, hook: 1 });
    assert.strictEqual(sessions.get(200).procs, 3);
  });
  await t.test('this session is self', () => assert.strictEqual(sessions.get(500).state, 'self'));
  await t.test('a CLI whose launcher died is orphan-cli', () => assert.strictEqual(sessions.get(350).state, 'orphan-cli'));
  await t.test('the session id is read from the command line when unregistered', () => {
    assert.strictEqual(sessions.get(350).sessionId, '11111111-2222-4333-8444-555555555555');
  });
  await t.test('a registry entry from an earlier process with the same PID is ignored', () => {
    const stale = new Map([[200, { pid: 200, sessionId: 's-x', status: 'idle', updatedAt: NOW - 20 * HOUR, procStart: '134000000000000000' }]]);
    assert.strictEqual(byPid(sessionInventory(ctxWith({ registry: stale }))).get(200).state, 'unknown');
  });
});

test('sessions keep apps and OS processes found in their tree', () => {
  const processes = [
    proc(1, 0, 'explorer.exe', 'explorer.exe', 300),
    proc(200, 1, 'claude', '/Users/u/.local/bin/claude', 30),
    proc(201, 200, 'Code', '/Applications/Visual Studio Code.app/Contents/MacOS/Code', 20),
    proc(202, 200, 'tmux: server', 'tmux new -s x', 20),
    proc(203, 200, 'node', 'node mcp.js', 20),
  ];
  const [session] = sessionInventory(buildContext({ processes, now: NOW }));
  assert.deepStrictEqual(session.members.filter((m) => m.keep).map((m) => m.pid), [201, 202]);
});

test('a CLI adopted by launchd/systemd is judged by its activity', () => {
  const processes = [proc(1, 0, 'systemd', '/sbin/init', 300), proc(700, 1, 'claude', 'claude -p "nightly job"', 2), proc(701, 1, 'claude', 'claude', 2)];
  const registry = new Map([[700, { pid: 700, sessionId: 'a', status: 'busy', updatedAt: NOW - 1000 }]]);
  const sessions = byPid(sessionInventory(buildContext({ processes, registry, now: NOW })));
  assert.strictEqual(sessions.get(700).state, 'active');
  assert.strictEqual(sessions.get(701).state, 'orphan-cli', 'no activity signal');
});

test('desktop terminals and IDE hosts', () => {
  const ctx = ctxWith();
  assert.deepStrictEqual(desktopTerminals(ctx).map((t) => t.pid), [130]);
  const hosts = ideHosts(ctx);
  assert.strictEqual(hosts.length, 1);
  assert.strictEqual(hosts[0].label, 'Cursor');
  assert.strictEqual(hosts[0].mcp, 1);
});

test('selectTargets', async (t) => {
  const result = {
    orphans: [{ category: 'orphan-agent', pid: 300 }, { category: 'orphan-task', pid: 310 }],
    stuckHooks: [],
    sessions: [{ category: 'stale', pid: 200 }, { category: 'unknown', pid: 210 }, { category: 'self', pid: 500 }],
  };
  const prot = new Set([500]);
  await t.test('only the requested categories', () => assert.deepStrictEqual(selectTargets(result, ['orphan-agent'], [], prot).map((x) => x.pid), [300]));
  await t.test('never this session', () => assert.strictEqual(selectTargets(result, ['self', 'stale'], [], prot).length, 1));
  await t.test('unknown sessions need explicit PIDs', () => {
    assert.strictEqual(selectTargets(result, ['unknown'], [], prot).length, 0);
    assert.strictEqual(selectTargets(result, ['unknown'], [210], prot).length, 1);
  });
  await t.test('--only filters', () => assert.deepStrictEqual(selectTargets(result, ['orphan-agent', 'orphan-task'], [310], prot).map((x) => x.pid), [310]));
});
