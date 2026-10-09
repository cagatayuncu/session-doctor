'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lib } = require('./helpers');

const { tierOf, projectOf, summarize } = lib('summary');
const status = lib('status');
const install = lib('install');

function s(state, extra = {}) {
  return { state, agent: 'claude', pid: 1, status: 'idle', idleMinutes: 120, ageHours: 5, procs: 3, mb: 100, children: { mcp: 2 }, cwd: '', ...extra };
}

function diag(sessions, orphans = [], stuckHooks = []) {
  return { sessions, orphans, stuckHooks };
}

test('idle tiers', () => {
  assert.strictEqual(tierOf(s('self')), 'this');
  assert.strictEqual(tierOf(s('active', { status: 'busy', idleMinutes: 50 })), 'working');
  assert.strictEqual(tierOf(s('active', { status: '', idleMinutes: 2 })), 'working', 'no status: very recent counts as working');
  assert.strictEqual(tierOf(s('active', { idleMinutes: 20 })), 'recent');
  assert.strictEqual(tierOf(s('active', { idleMinutes: 300 })), 'idle');
  for (const state of ['stale', 'hung', 'orphan-cli', 'unknown']) assert.strictEqual(tierOf(s(state)), state);
});

test('project names, worktrees and folderless sessions', () => {
  assert.deepStrictEqual(projectOf(s('active', { cwd: 'C:\\Repositories\\shop' })), { group: 'shop', where: '' });
  assert.deepStrictEqual(projectOf(s('active', { cwd: '/r/shop/.claude/worktrees/brave-x' })), { group: 'shop', where: 'worktree brave-x' });
  assert.strictEqual(projectOf(s('active', { cwd: 'C:\\Users\\u\\AppData\\Roaming\\Claude\\scratch-workspaces\\a\\b' })).group, '(no project folder)');
  assert.strictEqual(projectOf(s('active', { agent: 'cursor' })).group, '(cursor sessions)');
});

test('summary groups by project and totals what can be freed', () => {
  const sum = summarize(diag(
    [s('self', { pid: 9, cwd: '/r/a' }), s('stale', { pid: 1, cwd: '/r/b', mb: 400, procs: 8 }), s('active', { pid: 2, cwd: '/r/b', idleMinutes: 10 })],
    [{ category: 'orphan-agent', pid: 7, mb: 44, procs: 1 }, { category: 'orphan-task', pid: 8, mb: 200, procs: 5 }],
  ));
  assert.deepStrictEqual(sum.groups.map((g) => g.name), ['a', 'b']);
  assert.deepStrictEqual(sum.groups[1].sessions.map((x) => x.pid), [2, 1], 'most recent first');
  assert.deepStrictEqual(sum.reclaim, { count: 3, procs: 14, mb: 644, pids: [7, 8, 1] });
  assert.strictEqual(sum.sessions.mcp, 6);
});

test('status warns only when something is worth cleaning', () => {
  const quiet = status.findings(summarize(diag([s('active', { idleMinutes: 10 })])));
  assert.strictEqual(quiet.warn, false);
  assert.match(quiet.text, /nothing to clean up/);
  assert.strictEqual(status.hookOutput('claude', quiet), '');

  const leaked = status.findings(summarize(diag([s('stale', { mb: 3000 })], [{ category: 'orphan-agent', pid: 7, mb: 44, procs: 1 }])));
  assert.strictEqual(leaked.warn, true);
  assert.match(leaked.text, /1 leaked agent process group, 1 stale session; about 3\.0 GB could be freed/);
  const claude = JSON.parse(status.hookOutput('claude', leaked));
  assert.strictEqual(claude.systemMessage, leaked.text);
  assert.strictEqual(claude.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(claude.hookSpecificOutput.additionalContext, /do not run cleanup unasked/);
  assert.match(JSON.parse(status.hookOutput('cursor', leaked)).additional_context, /session-doctor/);

  const twoStale = status.findings(summarize(diag([s('stale'), s('stale')])));
  assert.strictEqual(twoStale.warn, false, `fewer than ${status.WARN_STALE_SESSIONS} small stale sessions stay quiet`);
});

test('status cache honours its age and thresholds', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sd-status-')), 'status.json');
  status.writeCache(file, { warn: true, text: 'x' }, '12/30', 1000);
  assert.deepStrictEqual(status.readCache(file, 500, '12/30', 1400), { warn: true, text: 'x' });
  assert.strictEqual(status.readCache(file, 500, '12/30', 1600), null, 'too old');
  assert.strictEqual(status.readCache(file, 500, '6/30', 1400), null, 'other thresholds');
  assert.strictEqual(status.readCache(file, 500, '12/30', 900), null, 'from the future');
  status.clearCache(file);
  assert.strictEqual(status.readCache(file, 500, '12/30', 1400), null);
});

test('leftover background jobs also trigger the warning', () => {
  const finding = status.findings(summarize(diag([], [{ category: 'orphan-task', pid: 8, mb: 50, procs: 2 }])));
  assert.strictEqual(finding.warn, true);
  assert.match(finding.text, /1 leftover background job/);
});

test('a stuck hook inside a session that would be closed is counted once', () => {
  const session = s('hung', { pid: 1, mb: 300, procs: 2, members: [{ pid: 1 }, { pid: 5 }] });
  const sum = summarize(diag([session], [], [{ category: 'stuck-hook', pid: 5, mb: 50, procs: 1 }]));
  assert.deepStrictEqual([sum.reclaim.mb, sum.reclaim.procs], [300, 2]);
});

test('hook commands are quoted for the shell that runs them', () => {
  const posix = install.hookCommand('/home/u$er/.session-doctor/bin', 'claude', "/opt/it's/node", false);
  assert.strictEqual(posix, `'/opt/it'\\''s/node' '${path.join('/home/u$er/.session-doctor/bin', 'session-doctor.js')}' status --hook claude`);
  assert.strictEqual(install.quoteArg('C:\\Program Files\\nodejs\\node.exe', 'claude', true), "'C:/Program Files/nodejs/node.exe'", 'Git Bash');
  assert.strictEqual(install.quoteArg('C:\\Program Files\\nodejs\\node.exe', 'cursor', true), '"C:/Program Files/nodejs/node.exe"', 'Cursor on Windows');
  assert.strictEqual(install.quoteArg('/a\\b', 'claude', false), "'/a\\b'", 'backslashes stay on POSIX');
});

test('Claude settings: the hook is added once and removed without touching other hooks', () => {
  const settings = { model: 'x', hooks: { SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'other.exe start' }] }], Stop: [] } };
  const command = install.hookCommand('/h/.session-doctor/bin', 'claude', '/usr/bin/node', false);
  const once = install.withClaudeHook(settings, command);
  const twice = install.withClaudeHook(once, command);
  assert.deepStrictEqual(twice, once, 'installing again does not duplicate');
  assert.strictEqual(once.hooks.SessionStart.length, 2);
  assert.deepStrictEqual(once.hooks.SessionStart[1], { matcher: 'startup', hooks: [{ type: 'command', command, timeout: install.HOOK_TIMEOUT_SEC }] });
  assert.deepStrictEqual(install.withoutClaudeHook(once), settings);
  assert.deepStrictEqual(settings.hooks.SessionStart.length, 1, 'input is not mutated');
  assert.deepStrictEqual(install.withoutClaudeHook(install.withClaudeHook({}, command)), {});
});

test('Cursor hooks.json: the hook is added once and removed', () => {
  const command = install.hookCommand('/h/.session-doctor/bin', 'cursor', '/usr/bin/node', false);
  const once = install.withCursorHook(null, command);
  assert.deepStrictEqual(once, { version: 1, hooks: { sessionStart: [{ command, timeout: install.HOOK_TIMEOUT_SEC }] } });
  assert.deepStrictEqual(install.withCursorHook(once, command), once);
  assert.deepStrictEqual(install.withoutCursorHook(once), { version: 1, hooks: {} });
});

test('install plan and apply back up existing files and skip missing agents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-install-'));
  const homes = { claudeHome: path.join(root, '.claude'), cursorHome: path.join(root, '.cursor') };
  fs.mkdirSync(homes.claudeHome);
  fs.writeFileSync(path.join(homes.claudeHome, 'settings.json'), '{"model":"x"}');
  const binDir = path.join(root, '.session-doctor', 'bin');
  const changes = install.plan('install', ['claude', 'cursor'], homes, binDir);
  assert.deepStrictEqual(changes.map((c) => c.agent), ['claude'], 'Cursor is not installed here');
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(path.join(scriptsDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, 'session-doctor.js'), '// stub');
  const backups = install.apply(changes, { scriptsDir, binDir, copy: true });
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(fs.readFileSync(backups[0], 'utf8'), '{"model":"x"}');
  assert.ok(fs.existsSync(path.join(binDir, 'session-doctor.js')));
  const written = JSON.parse(fs.readFileSync(path.join(homes.claudeHome, 'settings.json'), 'utf8'));
  assert.strictEqual(written.model, 'x');
  assert.match(written.hooks.SessionStart[0].hooks[0].command, /status --hook claude$/);
  assert.throws(() => install.apply(changes, { scriptsDir, binDir: path.join(root, 'elsewhere'), copy: true }), /refusing/);
});

function tempHomes(claudeSettings, cursorHooks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-install-'));
  const homes = { claudeHome: path.join(root, '.claude'), cursorHome: path.join(root, '.cursor') };
  fs.mkdirSync(homes.claudeHome);
  fs.mkdirSync(homes.cursorHome);
  if (claudeSettings !== undefined) fs.writeFileSync(path.join(homes.claudeHome, 'settings.json'), claudeSettings);
  if (cursorHooks !== undefined) fs.writeFileSync(path.join(homes.cursorHome, 'hooks.json'), cursorHooks);
  return { root, homes, binDir: path.join(root, '.session-doctor', 'bin') };
}

test('install refuses settings it cannot parse or does not understand', () => {
  for (const bad of ['{ broken', '[1,2]', '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}']) {
    const { homes, binDir } = tempHomes(bad);
    assert.throws(() => install.plan('install', ['claude'], homes, binDir), /not valid JSON|not changing it/, bad);
  }
});

test('uninstall changes nothing and creates nothing when the hook is not there', () => {
  const { homes, binDir } = tempHomes('{"model":"x"}');
  const changes = install.plan('uninstall', ['claude', 'cursor'], homes, binDir);
  assert.deepStrictEqual(changes.map((c) => c.changed), [false, false]);
  install.apply(changes, { binDir, copy: false });
  assert.ok(!fs.existsSync(path.join(homes.cursorHome, 'hooks.json')));
});

test('apply keeps BOM, CRLF and indent, and refuses a file edited in the meantime', () => {
  const original = '﻿{\r\n    "model": "x"\r\n}\r\n';
  const { homes, binDir } = tempHomes(original);
  const file = path.join(homes.claudeHome, 'settings.json');
  install.apply(install.plan('install', ['claude'], homes, binDir), { binDir, copy: false });
  const written = fs.readFileSync(file, 'utf8');
  assert.ok(written.startsWith('﻿{\r\n    "model"'), 'same BOM, line endings and indent');
  const stale = install.plan('uninstall', ['claude'], homes, binDir);
  fs.writeFileSync(file, written.replace('"x"', '"y"'));
  assert.throws(() => install.apply(stale, { binDir, copy: false }), /changed while this ran/);
  assert.match(fs.readFileSync(file, 'utf8'), /"y"/, 'the other program\'s edit is kept');
});

test('the script copy never deletes the folder it runs from', () => {
  const { binDir } = tempHomes();
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'session-doctor.js'), '// installed');
  assert.strictEqual(install.copyScripts(binDir, binDir), false);
  const otherDriveCase = binDir.replace(/^([a-z]):/i, (m, d) => `${d === d.toLowerCase() ? d.toUpperCase() : d.toLowerCase()}:`);
  assert.strictEqual(install.copyScripts(otherDriveCase, binDir), false, 'drive-letter case does not fool it');
  assert.ok(fs.existsSync(path.join(binDir, 'session-doctor.js')));
  assert.ok(install.isRunningFrom(path.join(binDir, 'lib'), binDir));
});
