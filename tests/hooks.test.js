'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lib } = require('./helpers');

const { fromClaudeBlock, fromCursorFile, loadHookConfig, matcherMatches, hotPath } = lib('hooks');

test('a split command and args array is joined', () => {
  const block = { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/run.js', 'x.py'] }] }] };
  const [hook] = fromClaudeBlock(block, 'claude:plugin:seo', 'C:\\p\\seo');
  assert.strictEqual(hook.command, 'node ${CLAUDE_PLUGIN_ROOT}/hooks/run.js x.py');
  assert.strictEqual(hook.matcher, 'Edit|Write');
});

test('malformed entries are skipped and timeouts kept', () => {
  const block = { PreToolUse: [null, { matcher: '*', hooks: [null, 'x', { type: 'command', command: 'node a.js', timeout: 90 }] }] };
  const hooks = fromClaudeBlock(block, 'claude:user');
  assert.deepStrictEqual(hooks.map((h) => [h.command, h.timeout]), [['node a.js', 90]]);
  assert.deepStrictEqual(fromCursorFile({ hooks: { stop: [null, { command: 'x', timeout: 'soon' }] } }, 'cursor:user').map((h) => h.timeout), [null]);
});

test('Cursor hooks.json, skipping prompt hooks', () => {
  const json = { version: 1, hooks: { afterFileEdit: [{ command: './hooks/format.sh' }, { type: 'prompt', prompt: 'x' }], beforeShellExecution: [{ command: 'node guard.js' }] } };
  const hooks = fromCursorFile(json, 'cursor:user');
  assert.deepStrictEqual(hooks.map((h) => `${h.event}:${h.command}`), ['afterFileEdit:./hooks/format.sh', 'beforeShellExecution:node guard.js']);
});

test('matchers are anchored', () => {
  assert.ok(matcherMatches('', 'Read'));
  assert.ok(matcherMatches('*', 'Read'));
  assert.ok(matcherMatches('Edit|Write', 'Edit'));
  assert.ok(!matcherMatches('Edit|Write', 'Read'));
  assert.ok(!matcherMatches('Bash', 'BashOutput'));
});

test('hot path counts per agent and tool', () => {
  const config = [
    { agent: 'claude', event: 'PreToolUse', matcher: 'Bash' },
    { agent: 'claude', event: 'PostToolUse', matcher: '*' },
    { agent: 'claude', event: 'PostToolUse', matcher: 'Edit|Write' },
    { agent: 'claude', event: 'Stop', matcher: '' },
    { agent: 'cursor', event: 'afterFileEdit', matcher: '' },
    { agent: 'cursor', event: 'postToolUse', matcher: '' },
  ];
  const rows = hotPath(config);
  const find = (agent, tool) => rows.find((r) => r.agent === agent && r.tool === tool);
  assert.strictEqual(find('claude', 'Bash').total, 2);
  assert.strictEqual(find('claude', 'Edit').total, 2);
  assert.strictEqual(find('cursor', 'Edit').total, 2);
  assert.strictEqual(find('cursor', 'Read').total, 1);
});

test('loads user settings, enabled plugins and Cursor hooks from disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-hooks-'));
  const claudeHome = path.join(root, '.claude');
  const cursorHome = path.join(root, '.cursor');
  const pluginRoot = path.join(claudeHome, 'plugins', 'cache', 'm', 'p', '1.0.0');
  fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
  fs.mkdirSync(cursorHome, { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'p@m': true, 'off@m': false },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node stop.js' }] }] },
  }));
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2, plugins: { 'p@m': [{ scope: 'user', installPath: pluginRoot }], 'off@m': [{ installPath: path.join(root, 'nope') }] },
  }));
  fs.writeFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/x.js' }] }] } }));
  fs.writeFileSync(path.join(cursorHome, 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'node c.js' }] } }));
  const config = loadHookConfig({ claudeHome, cursorHome, projectDir: root });
  assert.deepStrictEqual(config.map((h) => `${h.source}:${h.event}`).sort(), ['claude:plugin:p@m:PreToolUse', 'claude:user:Stop', 'cursor:user:stop']);
  assert.strictEqual(config.find((h) => h.event === 'PreToolUse').pluginRoot, pluginRoot);
});
