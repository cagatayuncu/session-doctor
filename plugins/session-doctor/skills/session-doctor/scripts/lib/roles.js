'use strict';
// What a process is: an agent CLI session, a desktop/IDE app, a hook, an MCP server,
// a tool shell, a dev server... Decided from its name and command line only.

const { normalizeCommand, normName } = require('./util');

const SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'nu', 'cmd', 'pwsh', 'powershell', 'conhost']);
const INIT_NAMES = new Set(['launchd', 'systemd', 'init']);
// Never part of a stopped group, whatever the classification says.
const NEVER_STOP = new Set([
  'explorer', 'winlogon', 'csrss', 'services', 'lsass', 'svchost', 'dwm', 'sihost', 'taskhostw', 'runtimebroker',
  'windowsterminal', 'openconsole', 'launchd', 'windowserver', 'loginwindow', 'finder', 'dock', 'systemuiserver',
  'terminal', 'iterm2', 'kernel_task', 'systemd', 'init', 'gnome-shell', 'plasmashell', 'xorg', 'xwayland', 'sshd',
  'tmux', 'screen', 'code', 'cursor', 'windsurf',
]);
// Interpreter/shell binaries say nothing about which hook runs, so they never form a signature.
const INTERPRETERS = new Set(['node', 'python', 'python3', 'py', 'pythonw', 'bash', 'sh', 'zsh', 'cmd', 'pwsh',
  'powershell', 'npx', 'npm', 'uvx', 'uv', 'bun', 'deno']);
const MIN_SIGNATURE_WORDS = 2;
const MIN_SIGNATURE_LENGTH = 12;

const CLAUDE_CLI_DIR = /[\\/]claude-code[\\/]/i;
const DESKTOP_PATH = /\\WindowsApps\\Claude_|\\AnthropicClaude\\|[\\/]Claude\.app[\\/]Contents[\\/]|[\\/]claude-desktop[\\/]/i;
const CLAUDE_SHELL = /shell-snapshots[\\/]snapshot-|__claudeCodeScript|CLAUDE_CODE_SHELL/;
// Hook scripts in a hidden tool folder (.claude/hooks, .cursor/hooks, .pixel-agents/hooks, ...)
// or launched through a plugin bootstrap. Project folders such as src/hooks and git hook
// folders (.git/hooks, .husky) do not match.
const GENERIC_HOOK = /plugin-hook-bootstrap|[\\/]\.(?!git[\\/]|husky[\\/])[\w.-]+[\\/]hooks[\\/][^\\/"\s]+\.(js|mjs|cjs|ts|py|sh|ps1)\b/i;
// How agents run a hook command: through a shell in command mode, never an interactive one.
const NON_INTERACTIVE_SHELL = /(^|\s)(-c|\/c|-command|-encodedcommand|-file)(\s|$)/i;
const MCP = /\bmcp\b|mcp[-_]server/i;
const PLUGIN = /[\\/]\.claude[\\/]plugins[\\/]|CLAUDE_PLUGIN_ROOT|[\\/]\.cursor[\\/]plugins[\\/]/i;
const DEV_SERVER = new RegExp([
  '\\b(vite|quasar|nuxt|webpack|react-scripts|astro|remix|parcel|nodemon|storybook|playwright|vitest|jest|uvicorn|gunicorn|runserver)\\b',
  'next(\\.js)?\\s+(dev|start)',
  'ng\\s+serve',
  '\\b(npm|pnpm|yarn|bun|npx)\\b.*\\b(dev|start|serve|watch|preview|test)\\b',
  '\\bdotnet(\\.exe)?"?\\s+(run|watch|test)\\b',
].join('|'), 'i');
const PATH_TOKEN = /[^\s"'=]+\.(js|mjs|cjs|ts|py|sh|ps1|exe|cmd|bat)\b/g;

// Agent CLIs whose session processes are inventoried. Add a row to cover another agent.
const AGENT_CLIS = [
  { agent: 'claude', test: (name, cmd) => name === 'claude' || /@anthropic-ai[\\/]claude-code[\\/]cli\.js/i.test(cmd) },
  { agent: 'cursor', test: (name, cmd) => name === 'cursor-agent' || /[\\/]cursor-agent[\\/]/i.test(cmd) },
  { agent: 'codex', test: (name, cmd) => name === 'codex' || /@openai[\\/]codex[\\/]/i.test(cmd) },
  { agent: 'gemini', test: (name, cmd) => name === 'gemini' || /@google[\\/]gemini-cli[\\/]/i.test(cmd) },
  { agent: 'opencode', test: (name, cmd) => name === 'opencode' || /[\\/]opencode-ai[\\/]/i.test(cmd) },
  { agent: 'copilot', test: (name, cmd) => name === 'copilot' || /@github[\\/]copilot[\\/]/i.test(cmd) },
];

const IDE_APPS = [
  { label: 'Cursor', test: (name, cmd) => /^cursor( helper.*)?$/.test(name) || /[\\/]Cursor\.app[\\/]Contents[\\/]|[\\/]programs[\\/]cursor[\\/]cursor\.exe/i.test(cmd) },
  { label: 'VS Code', test: (name, cmd) => /^code( helper.*)?$/.test(name) || /Visual Studio Code\.app[\\/]Contents[\\/]|[\\/]Microsoft VS Code[\\/]Code\.exe/i.test(cmd) },
  { label: 'Windsurf', test: (name, cmd) => /^windsurf( helper.*)?$/.test(name) || /[\\/]Windsurf\.app[\\/]Contents[\\/]/i.test(cmd) },
];

function isDesktopApp(name, cmd) {
  if (CLAUDE_CLI_DIR.test(cmd)) return false;
  if (name.startsWith('claude helper')) return true;
  return name === 'claude' && (/--type=/.test(cmd) || DESKTOP_PATH.test(cmd));
}

function cliAgent(name, cmd) {
  const row = AGENT_CLIS.find((r) => r.test(name, cmd));
  return row ? row.agent : null;
}

function ideLabel(name, cmd) {
  const row = IDE_APPS.find((r) => r.test(name, cmd));
  return row ? row.label : null;
}

// A signature recognises the processes of one configured hook. It is "strong" when it
// holds the hook script's full absolute path, "loose" when only a relative path, a
// path tail or a path-less command is known (e.g. `npm run lint`, `$CLAUDE_PROJECT_DIR/x.js`).
// Returns null when the command is too generic, e.g. a bare "node" whose script sits in
// a separate args array.
function hookSignature(command, pluginRoot = '', timeoutSec = null) {
  let text = String(command || '');
  if (pluginRoot) text = text.replace(/\$\{?CLAUDE_PLUGIN_ROOT\}?/g, () => pluginRoot);
  const norm = normalizeCommand(text);
  const paths = [...norm.matchAll(PATH_TOKEN)].filter((m) => !INTERPRETERS.has(normName(m[0]).replace(/\.(cmd|bat)$/, '')));
  if (paths.length === 0) {
    if (norm.split(' ').length < MIN_SIGNATURE_WORDS || norm.length < MIN_SIGNATURE_LENGTH) return null;
    return { tokens: [norm], whole: true, strength: 'loose', timeoutSec };
  }
  const last = paths[paths.length - 1];
  const absolute = /^([a-z]:\/|\/)/.test(last[0]) && !/[$~%]/.test(last[0]);
  const tokens = [absolute ? last[0] : last[0].split('/').filter(Boolean).slice(-2).join('/')];
  const rest = norm.slice(last.index + last[0].length).replace(/^["'\s]+/, '');
  const firstArg = rest.split(/\s+/).find((w) => w && !w.startsWith('-'));
  if (firstArg) tokens.push(firstArg.replace(/["']/g, ''));
  return { tokens, whole: false, strength: absolute ? 'strong' : 'loose', timeoutSec };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function signatureMatches(norm, signature) {
  const [first, ...others] = signature.tokens;
  if (!first) return false;
  // A path-less command must appear as a complete argument: `npm run test` is not `npm run test:e2e`.
  if (signature.whole) return new RegExp(`(^|[\\s"'])${escapeRegex(first)}(?=$|["'\\s])`).test(norm);
  if (!norm.includes(first)) return false;
  return others.every((token) => new RegExp(`(?<![\\w-])${escapeRegex(token)}(?![\\w-])`).test(norm));
}

// null, or { strength, timeoutSec } of the best matching hook.
function hookMatch(cmd, signatures = []) {
  if (!cmd) return null;
  if (GENERIC_HOOK.test(cmd)) return { strength: 'strong', timeoutSec: null };
  const norm = normalizeCommand(cmd);
  const matches = signatures.filter((sig) => signatureMatches(norm, sig));
  if (matches.length === 0) return null;
  const strong = matches.find((m) => m.strength === 'strong');
  const timeouts = matches.map((m) => Number(m.timeoutSec)).filter((t) => t > 0);
  return { strength: strong ? 'strong' : 'loose', timeoutSec: timeouts.length ? Math.max(...timeouts) : null };
}

function isHookCommand(cmd, signatures = []) {
  return hookMatch(cmd, signatures) !== null;
}

function isNonInteractiveShell(cmd) {
  return NON_INTERACTIVE_SHELL.test(String(cmd || ''));
}

// "tmux: server", "screen" ... are compared by their first word.
function isNeverStop(name) {
  const base = normName(name);
  return NEVER_STOP.has(base) || NEVER_STOP.has(base.split(/[\s:]/)[0]);
}

function processRole(proc, signatures = []) {
  const name = normName(proc.name);
  const cmd = proc.cmd || '';
  if (isDesktopApp(name, cmd)) return 'desktop-app';
  if (ideLabel(name, cmd)) return 'ide-app';
  if (cliAgent(name, cmd)) return 'cli';
  if (CLAUDE_SHELL.test(cmd)) return 'claude-shell';
  if (isHookCommand(cmd, signatures)) return 'hook';
  if (MCP.test(cmd)) return 'mcp';
  if (PLUGIN.test(cmd)) return 'plugin';
  if (DEV_SERVER.test(cmd)) return 'dev-server';
  if (SHELLS.has(name)) return 'shell';
  if (INIT_NAMES.has(name)) return 'init';
  return 'other';
}

// Print/one-shot mode per agent. Only the part before the first quote is inspected, so
// a "-p" inside a prompt does not count. codex's -p means --profile; its one-shot is `exec`.
const HEADLESS = {
  claude: /(^|\s)(-p|--print)(\s|$)/,
  cursor: /(^|\s)(-p|--print)(\s|$)/,
  gemini: /(^|\s)(-p|--prompt)(\s|$)/,
  codex: /(^|\s)exec(\s|$)/,
};

function isHeadless(agent, cmd) {
  const pattern = HEADLESS[agent];
  if (!pattern) return false;
  return pattern.test(String(cmd || '').split(/["']/)[0]);
}

module.exports = {
  SHELLS,
  INIT_NAMES,
  NEVER_STOP,
  AGENT_CLIS,
  hookSignature,
  hookMatch,
  isHookCommand,
  isNonInteractiveShell,
  isNeverStop,
  processRole,
  cliAgent,
  ideLabel,
  isHeadless,
};
