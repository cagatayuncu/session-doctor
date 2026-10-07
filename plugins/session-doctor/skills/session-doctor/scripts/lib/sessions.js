'use strict';
// When did an agent session last do something? Claude Code: ~/.claude/sessions/<pid>.json
// plus transcript tails. Cursor CLI: the chat store's mtime. Others: process facts only.

const fs = require('fs');
const path = require('path');
const { readJson, readTail, mtimeMs, listDir, MS_PER_MINUTE } = require('./util');
const { fileTimeToMs } = require('./platform');

const CONVERSATION_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);
const CONVERSATION_LINE = /"type":"(user|assistant|system|attachment)"/;
const TOOL_USE = /"type":"tool_use","id":"[^"]*","name":"([^"]+)"/g;
const PROC_START_TOLERANCE_MS = 2000;
const STARTED_AT_TOLERANCE_MS = 5000;

function loadRegistry(claudeHome) {
  const map = new Map();
  for (const file of listDir(path.join(claudeHome, 'sessions'), { files: true })) {
    if (!file.endsWith('.json')) continue;
    const entry = readJson(file);
    if (entry && Number.isFinite(Number(entry.pid))) map.set(Number(entry.pid), entry);
  }
  return map;
}

// The registry is keyed by PID; an entry left by an earlier process with the same PID
// must not be attributed to the current one.
function registryMatches(entry, proc) {
  if (!entry || proc.created == null) return Boolean(entry);
  const procStartMs = fileTimeToMs(entry.procStart);
  if (procStartMs != null && Math.abs(procStartMs - proc.created) > PROC_START_TOLERANCE_MS) return false;
  const startedAt = Number(entry.startedAt);
  return !(startedAt && startedAt < proc.created - STARTED_AT_TOLERANCE_MS);
}

function transcriptIndex(claudeHome) {
  const map = new Map();
  for (const dir of listDir(path.join(claudeHome, 'projects'), { dirs: true })) {
    for (const file of listDir(dir, { files: true })) {
      if (file.endsWith('.jsonl')) map.set(path.basename(file, '.jsonl'), file);
    }
  }
  return map;
}

// File mtime is not activity: apps append bookkeeping lines (artifact ledgers, titles)
// to idle transcripts. Only conversation entries count.
function lastConversationTime(tail) {
  const lines = String(tail).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!CONVERSATION_LINE.test(lines[i])) continue;
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; } // the first tail line is usually cut
    if (!CONVERSATION_TYPES.has(entry.type) || !entry.timestamp) continue;
    const ms = Date.parse(entry.timestamp);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

function lastToolName(tail) {
  const found = [...String(tail).matchAll(TOOL_USE)];
  return found.length ? found[found.length - 1][1] : '';
}

function newestFile(dir, ext) {
  let best = null;
  for (const file of listDir(dir, { files: true })) {
    if (!file.endsWith(ext)) continue;
    const m = mtimeMs(file);
    if (m != null && (!best || m > best.mtime)) best = { file, mtime: m };
  }
  return best;
}

function transcriptActivity(file) {
  const result = { lastActivity: null, lastTool: '', subagent: '' };
  if (!file) return result;
  let tail = readTail(file);
  result.lastActivity = lastConversationTime(tail);
  const sub = newestFile(path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents'), '.jsonl');
  // A subagent written after its parent's last entry is still in flight (or hung there).
  if (sub && (result.lastActivity == null || sub.mtime > result.lastActivity)) {
    const subTail = readTail(sub.file);
    const meta = readJson(sub.file.replace(/\.jsonl$/, '.meta.json'));
    result.subagent = (meta && meta.agentType) || 'subagent';
    const subLast = lastConversationTime(subTail);
    if (subLast != null && (result.lastActivity == null || subLast > result.lastActivity)) result.lastActivity = subLast;
    tail = subTail;
  }
  result.lastTool = lastToolName(tail);
  return result;
}

// ~/.cursor/chats/<workspace-hash>/<chat-id>/store.db
function cursorChatIndex(cursorHome) {
  const map = new Map();
  for (const workspace of listDir(path.join(cursorHome, 'chats'), { dirs: true })) {
    for (const chat of listDir(workspace, { dirs: true })) map.set(path.basename(chat), chat);
  }
  return map;
}

function cursorChatActivity(chatDir) {
  if (!chatDir) return null;
  const times = ['store.db', 'store.db-wal'].map((f) => mtimeMs(path.join(chatDir, f))).filter((t) => t != null);
  return times.length ? Math.max(...times) : null;
}

function sessionIdFromCommand(agent, cmd) {
  const pattern = agent === 'claude'
    ? /--(?:session-id|resume)[= ]"?([0-9a-fA-F-]{36})/
    : /--resume[= ]"?([\w-]{8,})/;
  const match = String(cmd || '').match(pattern);
  return match ? match[1] : '';
}

function activityState({ status, lastActivity, now, staleHours, hungMinutes, headless, ageMinutes }) {
  if (lastActivity == null) {
    // A print-mode run that is still alive after the stale window is not coming back.
    return headless && ageMinutes >= staleHours * 60 ? 'stale' : 'unknown';
  }
  const idleMinutes = (now - lastActivity) / MS_PER_MINUTE;
  if (status === 'busy') return idleMinutes >= hungMinutes ? 'hung' : 'active';
  return idleMinutes >= staleHours * 60 ? 'stale' : 'active';
}

// parentAlive=false with adopted=true means launchd/systemd/init took the process over:
// nohup'd or scheduled agents and WSL launches look like that while working fine, so
// their activity decides; only a silent one counts as orphaned.
function sessionState(input) {
  if (input.isSelf) return 'self';
  if (!input.parentAlive && !input.adopted) return 'orphan-cli';
  const state = activityState(input);
  if (!input.parentAlive && state === 'unknown') return 'orphan-cli';
  return state;
}

function claudeActivity(proc, ctx) {
  let entry = ctx.registry.get(proc.pid);
  if (entry && !registryMatches(entry, proc)) entry = null;
  const sessionId = (entry && entry.sessionId) || sessionIdFromCommand('claude', proc.cmd);
  const activity = transcriptActivity(ctx.transcripts.get(sessionId));
  const stamps = [entry && entry.updatedAt, entry && entry.statusUpdatedAt, activity.lastActivity]
    .map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return {
    sessionId,
    hostSessionId: (entry && entry.hostSessionId) || '',
    status: (entry && entry.status) || '',
    name: (entry && entry.name) || '',
    cwd: (entry && entry.cwd) || '',
    lastActivity: stamps.length ? Math.max(...stamps) : null,
    lastTool: activity.lastTool,
    subagent: activity.subagent,
  };
}

function cursorActivity(proc, ctx) {
  const sessionId = sessionIdFromCommand('cursor', proc.cmd);
  return { sessionId, hostSessionId: '', status: '', name: '', cwd: '', lastActivity: cursorChatActivity(ctx.cursorChats.get(sessionId)), lastTool: '', subagent: '' };
}

function sessionActivity(agent, proc, ctx) {
  if (agent === 'claude') return claudeActivity(proc, ctx);
  if (agent === 'cursor') return cursorActivity(proc, ctx);
  return { sessionId: sessionIdFromCommand(agent, proc.cmd), hostSessionId: '', status: '', name: '', cwd: '', lastActivity: null, lastTool: '', subagent: '' };
}

function isGitWorktreePath(cwd) {
  return /[\\/]\.(claude|cursor)[\\/]worktrees[\\/]/.test(String(cwd || '')) && fs.existsSync(cwd);
}

module.exports = {
  loadRegistry,
  registryMatches,
  transcriptIndex,
  lastConversationTime,
  lastToolName,
  transcriptActivity,
  cursorChatIndex,
  sessionIdFromCommand,
  sessionState,
  sessionActivity,
  isGitWorktreePath,
};
