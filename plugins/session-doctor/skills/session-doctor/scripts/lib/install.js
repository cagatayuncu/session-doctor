'use strict';
// Opt-in SessionStart hook: `hook install` copies the scripts to a stable folder
// (~/.session-doctor/bin, so plugin updates cannot break the hook) and registers
// `status --hook <agent>` in Claude Code's settings.json and/or Cursor's hooks.json.
// Settings files are changed carefully: shape checked, re-read right before writing,
// backed up under a unique name, written atomically, BOM/line endings/indent kept.

const fs = require('fs');
const path = require('path');
const { stripBom } = require('./util');

const IS_WIN = process.platform === 'win32';
const MARKER = /session-doctor\.js['"]? status --hook/;
const HOOK_TIMEOUT_SEC = 30;
const CLAUDE_MATCHER = 'startup';

// ---------------------------------------------------------------- the hook command

// POSIX shells (and Git Bash, which Claude Code uses for hooks on Windows): single quotes
// stop $, backtick and backslash expansion. Cursor on Windows may run the command through
// cmd, which does not understand single quotes, so it gets double quotes there.
function quoteArg(arg, agent, isWin = IS_WIN) {
  const text = isWin ? arg.replace(/\\/g, '/') : arg;
  if (isWin && agent === 'cursor') return `"${text}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function hookCommand(binDir, agent, nodePath = process.execPath, isWin = IS_WIN) {
  const script = path.join(binDir, 'session-doctor.js');
  return `${quoteArg(nodePath, agent, isWin)} ${quoteArg(script, agent, isWin)} status --hook ${agent}`;
}

function isOurs(hook) {
  return Boolean(hook && MARKER.test(String(hook.command || '')));
}

// ---------------------------------------------------------------- settings shapes

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Refuses anything it does not understand instead of "fixing" it.
function checkShape(json, listKey, file) {
  if (json === undefined) return;
  if (!isPlainObject(json)) throw new Error(`${file}: expected a JSON object at the top level; not changing it`);
  if (json.hooks !== undefined && !isPlainObject(json.hooks)) throw new Error(`${file}: "hooks" is not an object; not changing it`);
  const list = json.hooks && json.hooks[listKey];
  if (list !== undefined && !Array.isArray(list)) throw new Error(`${file}: "hooks.${listKey}" is not a list; not changing it`);
}

function claudeEntries(settings) {
  const groups = (settings && settings.hooks && settings.hooks.SessionStart) || [];
  return groups.flatMap((g) => (isPlainObject(g) && Array.isArray(g.hooks) ? g.hooks : [])).filter(isOurs);
}

function cursorEntries(json) {
  return ((json && json.hooks && json.hooks.sessionStart) || []).filter(isOurs);
}

// Claude Code settings.json without our SessionStart hook (other hooks untouched).
function withoutClaudeHook(settings) {
  const hooks = { ...((settings && settings.hooks) || {}) };
  const groups = (hooks.SessionStart || [])
    .map((g) => (isPlainObject(g) && Array.isArray(g.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !(isPlainObject(g) && Array.isArray(g.hooks) && g.hooks.length === 0));
  if (groups.length) hooks.SessionStart = groups;
  else delete hooks.SessionStart;
  const next = { ...(settings || {}), hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

function withClaudeHook(settings, command) {
  const base = withoutClaudeHook(settings);
  const hooks = { ...(base.hooks || {}) };
  const entry = { matcher: CLAUDE_MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SEC }] };
  hooks.SessionStart = [...(hooks.SessionStart || []), entry];
  return { ...base, hooks };
}

function withoutCursorHook(json) {
  const base = json || {};
  const hooks = { ...(base.hooks || {}) };
  const entries = (hooks.sessionStart || []).filter((h) => !isOurs(h));
  if (entries.length) hooks.sessionStart = entries;
  else delete hooks.sessionStart;
  return { ...base, hooks };
}

function withCursorHook(json, command) {
  const base = withoutCursorHook(json);
  return { version: 1, ...base, hooks: { ...base.hooks, sessionStart: [...(base.hooks.sessionStart || []), { command, timeout: HOOK_TIMEOUT_SEC }] } };
}

const AGENTS = {
  claude: { listKey: 'SessionStart', file: (h) => path.join(h.claudeHome, 'settings.json'), add: withClaudeHook, remove: withoutClaudeHook, ours: claudeEntries, home: (h) => h.claudeHome },
  cursor: { listKey: 'sessionStart', file: (h) => path.join(h.cursorHome, 'hooks.json'), add: withCursorHook, remove: withoutCursorHook, ours: cursorEntries, home: (h) => h.cursorHome },
};

// ---------------------------------------------------------------- reading and writing text

function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function parseRaw(raw, file) {
  if (raw === null) return undefined;
  try {
    return JSON.parse(stripBom(raw));
  } catch {
    throw new Error(`${file} is not valid JSON; fix it before changing hooks`);
  }
}

// Same BOM, line endings and indent as the original file.
function formatLike(raw, json) {
  const indentMatch = raw && raw.match(/\n([ \t]+)"/);
  const indent = indentMatch ? indentMatch[1] : 2;
  let text = `${JSON.stringify(json, null, indent)}\n`;
  if (raw && raw.includes('\r\n')) text = text.replace(/\n/g, '\r\n');
  if (raw && raw.charCodeAt(0) === 0xfeff) text = `﻿${text}`;
  return text;
}

function uniqueSuffix() {
  return `${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeAtomic(file, text) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.session-doctor-${uniqueSuffix()}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, target);
}

// ---------------------------------------------------------------- plan and apply

// [{ agent, file, raw, after, changed }] for `install` or `uninstall`; reads only.
function plan(action, agents, homes, binDir) {
  const changes = [];
  for (const agent of agents) {
    const spec = AGENTS[agent];
    if (!fs.existsSync(spec.home(homes))) continue;
    const file = spec.file(homes);
    const raw = readRaw(file);
    const before = parseRaw(raw, file);
    checkShape(before, spec.listKey, file);
    const command = hookCommand(binDir, agent);
    const ours = spec.ours(before);
    if (action === 'uninstall') {
      changes.push({ agent, file, raw, after: ours.length ? spec.remove(before) : before, changed: ours.length > 0 });
    } else {
      const upToDate = ours.length === 1 && ours[0].command === command;
      changes.push({ agent, file, raw, after: upToDate ? before : spec.add(before, command), changed: !upToDate });
    }
  }
  return changes;
}

function samePath(a, b) {
  const real = (p) => {
    const resolved = fs.existsSync(p) ? fs.realpathSync.native(p) : path.resolve(p);
    return IS_WIN ? resolved.toLowerCase() : resolved;
  };
  return real(a) === real(b);
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertOwnBinDir(binDir) {
  if (path.basename(binDir) !== 'bin' || path.basename(path.dirname(binDir)) !== '.session-doctor') {
    throw new Error(`refusing to replace unexpected folder ${binDir}`);
  }
}

function isRunningFrom(scriptsDir, binDir) {
  return samePath(scriptsDir, binDir) || isInside(scriptsDir, binDir);
}

// Copies into bin.new, then swaps it in: the old copy is only removed once the new one exists.
function copyScripts(scriptsDir, binDir) {
  assertOwnBinDir(binDir);
  if (isRunningFrom(scriptsDir, binDir)) return false;
  if (!fs.existsSync(path.join(scriptsDir, 'session-doctor.js'))) throw new Error(`no session-doctor.js in ${scriptsDir}`);
  const staging = `${binDir}.new`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(scriptsDir, staging, { recursive: true });
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.renameSync(staging, binDir);
  return true;
}

function removeScripts(binDir) {
  assertOwnBinDir(binDir);
  fs.rmSync(binDir, { recursive: true, force: true });
}

// Writes the planned files and returns the backups. A file that changed since plan() was
// read (another program edited it) is left alone and reported.
function apply(changes, { scriptsDir, binDir, copy }) {
  if (copy) copyScripts(scriptsDir, binDir);
  const backups = [];
  for (const change of changes.filter((c) => c.changed)) {
    const current = readRaw(change.file);
    if (current !== change.raw) throw new Error(`${change.file} changed while this ran; nothing was written to it. Run the command again.`);
    if (current !== null) {
      const backup = `${change.file}.bak-session-doctor-${uniqueSuffix()}`;
      fs.copyFileSync(change.file, backup, fs.constants.COPYFILE_EXCL);
      backups.push(backup);
    }
    writeAtomic(change.file, formatLike(current, change.after));
  }
  return backups;
}

module.exports = {
  HOOK_TIMEOUT_SEC, quoteArg, hookCommand, withClaudeHook, withoutClaudeHook, withCursorHook, withoutCursorHook,
  plan, apply, copyScripts, removeScripts, isRunningFrom,
};
