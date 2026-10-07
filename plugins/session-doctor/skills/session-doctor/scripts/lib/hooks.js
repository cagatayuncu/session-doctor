'use strict';
// Reads the hook configuration of Claude Code (settings + enabled plugins) and Cursor
// (hooks.json), and counts how many hook processes one tool call starts.

const path = require('path');
const { readJson } = require('./util');
const { cursorEnterpriseHooksFile } = require('./platform');

const CLAUDE_TOOLS = ['Read', 'Edit', 'Write', 'Bash'];
// Cursor fires generic tool hooks plus an operation-specific one.
const CURSOR_OPERATIONS = {
  Read: { pre: ['preToolUse', 'beforeReadFile'], post: ['postToolUse'] },
  Edit: { pre: ['preToolUse'], post: ['postToolUse', 'afterFileEdit'] },
  Shell: { pre: ['preToolUse', 'beforeShellExecution'], post: ['postToolUse', 'afterShellExecution'] },
  MCP: { pre: ['preToolUse', 'beforeMCPExecution'], post: ['postToolUse', 'afterMCPExecution'] },
};

function joinCommand(hook) {
  const parts = [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])];
  return parts.filter((p) => p != null && p !== '').map(String).join(' ');
}

// Claude: { Event: [ { matcher, hooks: [ { type, command, args? } ] } ] }
function fromClaudeBlock(hooks, source, pluginRoot = '') {
  const out = [];
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!group || typeof group !== 'object') continue;
      for (const hook of Array.isArray(group.hooks) ? group.hooks : []) {
        if (!hook || typeof hook !== 'object' || (hook.type || 'command') !== 'command') continue;
        out.push({ agent: 'claude', source, event, matcher: String(group.matcher || ''), command: joinCommand(hook), pluginRoot, timeout: timeoutOf(hook) });
      }
    }
  }
  return out;
}

function timeoutOf(hook) {
  const seconds = Number(hook.timeout);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

// Cursor: { version: 1, hooks: { event: [ { command, matcher?, type? } ] } }
function fromCursorFile(json, source) {
  const out = [];
  const hooks = json && json.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, entries] of Object.entries(hooks)) {
    for (const hook of Array.isArray(entries) ? entries : []) {
      if (!hook || typeof hook !== 'object' || (hook.type && hook.type !== 'command') || !hook.command) continue;
      out.push({ agent: 'cursor', source, event, matcher: String(hook.matcher || ''), command: joinCommand(hook), pluginRoot: '', timeout: timeoutOf(hook) });
    }
  }
  return out;
}

function claudeSettingsFiles(claudeHome, projectDir) {
  const files = [
    { source: 'claude:user', file: path.join(claudeHome, 'settings.json') },
    { source: 'claude:user-local', file: path.join(claudeHome, 'settings.local.json') },
  ];
  const projectClaude = projectDir ? path.join(projectDir, '.claude') : null;
  if (projectClaude && path.resolve(projectClaude) !== path.resolve(claudeHome)) {
    files.push({ source: 'claude:project', file: path.join(projectClaude, 'settings.json') });
    files.push({ source: 'claude:project-local', file: path.join(projectClaude, 'settings.local.json') });
  }
  return files;
}

function enabledPluginRoots(claudeHome, settingsList) {
  const enabled = {};
  for (const settings of settingsList) Object.assign(enabled, (settings && settings.enabledPlugins) || {});
  const installed = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  const plugins = (installed && installed.plugins) || {};
  const roots = [];
  for (const [name, installs] of Object.entries(plugins)) {
    if (!enabled[name]) continue;
    const paths = (Array.isArray(installs) ? installs : [installs]).map((i) => i && i.installPath).filter(Boolean);
    for (const root of new Set(paths)) roots.push({ name, root });
  }
  return roots;
}

// hooks/hooks.json by default; plugin.json "hooks" may name another file or inline the block.
function pluginHooks(plugin) {
  const manifest = readJson(path.join(plugin.root, '.claude-plugin', 'plugin.json')) || {};
  const files = new Set([path.join(plugin.root, 'hooks', 'hooks.json')]);
  if (typeof manifest.hooks === 'string') files.add(path.resolve(plugin.root, manifest.hooks));
  const blocks = [...files].map(readJson).filter(Boolean).map((json) => json.hooks);
  if (manifest.hooks && typeof manifest.hooks === 'object') blocks.push(manifest.hooks);
  return blocks.flatMap((block) => fromClaudeBlock(block, `claude:plugin:${plugin.name}`, plugin.root));
}

function claudeHooks(claudeHome, projectDir) {
  const settingsList = [];
  const hooks = [];
  for (const { source, file } of claudeSettingsFiles(claudeHome, projectDir)) {
    const json = readJson(file);
    if (!json) continue;
    settingsList.push(json);
    hooks.push(...fromClaudeBlock(json.hooks, source));
  }
  for (const plugin of enabledPluginRoots(claudeHome, settingsList)) hooks.push(...pluginHooks(plugin));
  return hooks;
}

function cursorHooks(cursorHome, projectDir) {
  const files = [
    { source: 'cursor:enterprise', file: cursorEnterpriseHooksFile() },
    { source: 'cursor:user', file: path.join(cursorHome, 'hooks.json') },
  ];
  const projectCursor = projectDir ? path.join(projectDir, '.cursor') : null;
  if (projectCursor && path.resolve(projectCursor) !== path.resolve(cursorHome)) {
    files.push({ source: 'cursor:project', file: path.join(projectCursor, 'hooks.json') });
  }
  return files.flatMap(({ source, file }) => fromCursorFile(readJson(file), source));
}

function loadHookConfig({ claudeHome, cursorHome, projectDir }) {
  return [...claudeHooks(claudeHome, projectDir), ...cursorHooks(cursorHome, projectDir)];
}

function matcherMatches(matcher, tool) {
  if (!matcher || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher === tool;
  }
}

function claudeHotPath(config) {
  const hooks = config.filter((h) => h.agent === 'claude');
  return CLAUDE_TOOLS.map((tool) => {
    const pre = hooks.filter((h) => h.event === 'PreToolUse' && matcherMatches(h.matcher, tool)).length;
    const post = hooks.filter((h) => h.event === 'PostToolUse' && matcherMatches(h.matcher, tool)).length;
    return { agent: 'claude', tool, pre, post, total: pre + post };
  });
}

// Cursor matchers are not tool names in every event, so these counts are an upper bound.
function cursorHotPath(config) {
  const hooks = config.filter((h) => h.agent === 'cursor');
  if (hooks.length === 0) return [];
  const count = (events) => hooks.filter((h) => events.includes(h.event)).length;
  return Object.entries(CURSOR_OPERATIONS).map(([tool, events]) => {
    const pre = count(events.pre);
    const post = count(events.post);
    return { agent: 'cursor', tool, pre, post, total: pre + post };
  });
}

function hotPath(config) {
  return [...claudeHotPath(config), ...cursorHotPath(config)];
}

module.exports = { fromClaudeBlock, fromCursorFile, loadHookConfig, matcherMatches, hotPath };
