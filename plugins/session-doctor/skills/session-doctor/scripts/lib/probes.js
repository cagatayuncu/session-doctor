'use strict';
// Read-only measurements that explain why sessions get slow: desktop-app inactivity
// timeouts, transcript bloat, hook disable lists, uncommitted worktree changes.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, readTail, listDir } = require('./util');
const { desktopLogCandidates } = require('./platform');

const LOG_TAIL_BYTES = 16 * 1024 * 1024;
const TIMEOUT_LINE = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d).*Session (\S+) timed out after (\d+)s of inactivity.*?last_tool_name=([^,)\s]+)/;
const MB = 1024 * 1024;

function parseTimeoutLines(text, sinceMs) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(TIMEOUT_LINE);
    if (!m) continue;
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
    if (at >= sinceMs) rows.push({ at, hostSessionId: m[7], seconds: Number(m[8]), lastTool: m[9] });
  }
  return rows;
}

function desktopTimeouts(hours, now = Date.now()) {
  const log = desktopLogCandidates().find((f) => fs.existsSync(f));
  if (!log) return { log: null, rows: [] };
  return { log, rows: parseTimeoutLines(readTail(log, LOG_TAIL_BYTES), now - hours * 3600000) };
}

function transcriptFiles(claudeHome) {
  const files = [];
  for (const project of listDir(path.join(claudeHome, 'projects'), { dirs: true })) {
    for (const file of listDir(project, { files: true })) if (file.endsWith('.jsonl')) files.push({ file, main: true });
    for (const session of listDir(project, { dirs: true })) {
      for (const file of listDir(path.join(session, 'subagents'), { files: true })) {
        if (file.endsWith('.jsonl')) files.push({ file, main: false });
      }
    }
  }
  return files.map((f) => {
    try {
      const stat = fs.statSync(f.file);
      return { ...f, size: stat.size, mtime: stat.mtimeMs };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function transcriptSummary(claudeHome, { top = 5, recent = 5 } = {}) {
  const files = transcriptFiles(claudeHome);
  const totalBytes = files.reduce((t, f) => t + f.size, 0);
  return {
    totalGb: Math.round((totalBytes / (1024 * MB)) * 100) / 100,
    files: files.length,
    largest: [...files].sort((a, b) => b.size - a.size).slice(0, top)
      .map((f) => ({ mb: Math.round(f.size / MB), lastWrite: f.mtime, project: path.basename(path.dirname(f.file)), id: path.basename(f.file, '.jsonl') })),
    recent: files.filter((f) => f.main).sort((a, b) => b.mtime - a.mtime).slice(0, recent).map((f) => f.file),
  };
}

function hookDisableVars(claudeHome) {
  const settings = readJson(path.join(claudeHome, 'settings.json'));
  const env = (settings && settings.env) || {};
  return Object.entries(env)
    .filter(([name]) => /DISABLED?_HOOKS|HOOKS?_DISABLED/i.test(name))
    .map(([name, value]) => ({ name, count: String(value).split(/[,;\s]+/).filter(Boolean).length }));
}

function worktreeChanges(cwd) {
  const result = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.status !== 0) return null;
  return result.stdout.split('\n').filter(Boolean).length;
}

module.exports = { parseTimeoutLines, desktopTimeouts, transcriptSummary, hookDisableVars, worktreeChanges };
