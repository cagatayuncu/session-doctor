'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lib } = require('./helpers');

const { processRole, hookSignature, hookMatch, isHookCommand, cliAgent, isHeadless, isNeverStop } = lib('roles');

const ORCH = 'C:/Tools/orchestrator/bin/daemon/orch.exe';
const SIGNATURES = [
  hookSignature(`"${ORCH}" hook stop --managed-by=orch`),
  hookSignature('node "C:\\Users\\u\\.pixel-agents\\hooks\\claude-hook.js"'),
  hookSignature('node ${CLAUDE_PLUGIN_ROOT}/hooks/run-python-hook.js ${CLAUDE_PLUGIN_ROOT}/hooks/validate-schema.py', 'C:\\p\\seo'),
].filter(Boolean);

const CASES = [
  // Claude desktop app and its CLI sessions
  ['claude.exe', 'C:\\Program Files\\WindowsApps\\Claude_2.1_x64__abc\\app\\Claude.exe', 'desktop-app'],
  ['claude.exe', 'C:\\x\\Claude.exe --type=renderer', 'desktop-app'],
  ['Claude', '/Applications/Claude.app/Contents/MacOS/Claude', 'desktop-app'],
  ['Claude Helper (Renderer)', '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer', 'desktop-app'],
  ['claude.exe', 'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude-code\\2.1.284\\claude.exe --output-format stream-json', 'cli'],
  ['claude', '/Users/u/Library/Application Support/Claude/claude-code/2.1.284/claude --output-format stream-json', 'cli'],
  ['claude', '/Users/u/.local/bin/claude', 'cli'],
  ['node', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi', 'cli'],
  // Other agent CLIs and IDEs
  ['node', 'node /Users/u/.local/share/cursor-agent/versions/2025.10/index.js --resume=abc12345', 'cli'],
  ['codex', 'codex exec "fix it"', 'cli'],
  ['Cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor', 'ide-app'],
  ['Cursor Helper (Plugin)', '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin) --type=utility', 'ide-app'],
  ['Cursor.exe', 'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\Cursor.exe', 'ide-app'],
  // Agent children
  ['bash.exe', 'bash -c "source /c/u/.claude/shell-snapshots/snapshot-bash-1.sh"', 'claude-shell'],
  ['node.exe', 'node C:\\Users\\u\\.pixel-agents\\hooks\\claude-hook.js', 'hook'],
  ['node', 'node /home/u/.cursor/hooks/format.js', 'hook'],
  ['node.exe', 'node -e "require(\'x/scripts/hooks/plugin-hook-bootstrap.js\')" node scripts/hooks/mcp-health-check.js', 'hook'],
  ['orch.exe', `${ORCH} hook session-start`, 'hook'],
  ['orch.exe', `${ORCH} mcp`, 'mcp'],
  ['orch.exe', `${ORCH} daemon --managed-by desktop`, 'other'],
  ['node.exe', 'node npx-cli.js -y chrome-devtools-mcp@latest', 'mcp'],
  ['node', 'node /home/u/.claude/plugins/cache/x/server.js', 'plugin'],
  ['node.exe', 'node C:\\Repos\\web\\node_modules\\vite\\bin\\vite.js --port 5174', 'dev-server'],
  ['node', 'node vitest run src/hooks/useAuth.test.ts', 'dev-server'],
  // Lookalikes that must stay unrelated
  ['dotnet.exe', '"C:\\Program Files\\dotnet\\dotnet.exe" MSBuild.dll /nodemode:1 /nodeReuse:true', 'other'],
  ['node-spawn-server', 'C:\\Users\\u\\AppData\\Local\\gitkraken\\app-12\\node-spawn-server', 'other'],
  ['sh', 'sh .git/hooks/pre-push.sh', 'shell'],
  ['cmd.exe', 'cmd.exe /c dir', 'shell'],
  ['zsh', '-zsh', 'shell'],
  ['launchd', '/sbin/launchd', 'init'],
];

for (const [name, cmd, role] of CASES) {
  test(`role of ${name}: ${cmd.slice(0, 60)} -> ${role}`, () => {
    assert.strictEqual(processRole({ name, cmd }, SIGNATURES), role);
  });
}

test('an absolute hook path is a strong signature with its subcommand', () => {
  const sig = hookSignature(`"${ORCH}" hook stop`, '', 30);
  assert.deepStrictEqual(sig.tokens, ['c:/tools/orchestrator/bin/daemon/orch.exe', 'hook']);
  assert.strictEqual(sig.strength, 'strong');
  assert.strictEqual(sig.timeoutSec, 30);
});

test('CLAUDE_PLUGIN_ROOT is resolved into a strong signature', () => {
  const sig = hookSignature('node "${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.js"', 'C:\\p\\plug');
  assert.deepStrictEqual(sig.tokens, ['c:/p/plug/scripts/on-stop.js']);
  assert.strictEqual(sig.strength, 'strong');
});

test('relative or variable paths only give a loose signature', () => {
  assert.strictEqual(hookSignature('node $CLAUDE_PROJECT_DIR/scripts/lint.js').strength, 'loose');
  assert.deepStrictEqual(hookSignature('node scripts/lint.js').tokens, ['scripts/lint.js']);
  assert.strictEqual(hookMatch('node scripts/lint.js --watch', [hookSignature('node scripts/lint.js')]).strength, 'loose');
});

test('a path-less hook command must match a whole argument', () => {
  const sig = hookSignature('npm run test');
  assert.ok(isHookCommand('bash -c "npm run test"', [sig]));
  assert.ok(!isHookCommand('npm run test:e2e', [sig]));
});

test('never-stop names compare their first word', () => {
  assert.ok(isNeverStop('tmux: server'));
  assert.ok(isNeverStop('Explorer.EXE'));
  assert.ok(!isNeverStop('node'));
});

test('a bare interpreter is too generic to be a signature', () => {
  assert.strictEqual(hookSignature('node'), null);
  assert.strictEqual(hookSignature('"C:\\nvm4w\\nodejs\\node.exe"'), null);
  assert.strictEqual(hookSignature('npx.cmd'), null);
});

test('a path-less command is matched as a whole', () => {
  const sig = hookSignature('/usr/local/bin/gk ai hook run --host claude-code');
  assert.ok(isHookCommand('/bin/sh -c /usr/local/bin/gk ai hook run --host claude-code', [sig]));
  assert.ok(!isHookCommand('/usr/local/bin/gk status', [sig]));
});

test('agent and headless detection', () => {
  assert.strictEqual(cliAgent('cursor-agent', 'cursor-agent -p "x"'), 'cursor');
  assert.strictEqual(cliAgent('node', 'node server.js'), null);
  assert.ok(isHeadless('claude', 'claude -p "do it"'));
  assert.ok(isHeadless('cursor', 'cursor-agent --print x'));
  assert.ok(isHeadless('codex', 'codex exec "fix it"'));
  assert.ok(!isHeadless('claude', 'claude --output-format stream-json --input-format stream-json'));
  assert.ok(!isHeadless('claude', 'claude "explain what -p does"'), 'a -p inside the prompt does not count');
  assert.ok(!isHeadless('codex', 'codex -p work'), 'codex -p is --profile');
  assert.ok(!isHeadless('opencode', 'opencode -p x'), 'unknown agents are never headless');
});
