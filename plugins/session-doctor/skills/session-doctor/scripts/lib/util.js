'use strict';
// Small shared helpers: config locations, safe file reads, text formatting.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TAIL_BYTES = 256 * 1024;
const MS_PER_MINUTE = 60000;

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function cursorHome() {
  return path.join(os.homedir(), '.cursor');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function listDir(dir, { dirs = false, files = false } = {}) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => (dirs && d.isDirectory()) || (files && d.isFile()))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function normalizeCommand(text) {
  return String(text || '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Lower-case executable name without directory or .exe, e.g. "C:\x\Node.EXE" -> "node".
function normName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return base.toLowerCase().replace(/\.exe$/, '');
}

function truncate(text, max) {
  const s = String(text == null ? '' : text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}~`;
}

// Claude's Bash tool wraps the real command: bash -c "source snapshot ... && eval '<cmd>' < /dev/null ..."
function shortCommand(cmd, max = 110) {
  let text = String(cmd || '');
  const wrapped = text.match(/eval '(.+?)' < \/dev\/null/);
  if (wrapped) [, text] = wrapped;
  return truncate(text.replace(/\s+/g, ' ').trim(), max);
}

function formatSpan(minutes) {
  if (minutes == null || Number.isNaN(minutes)) return '?';
  const m = Math.max(0, Math.round(minutes));
  if (m >= 1440) return `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h${m % 60}m`;
  return `${m}m`;
}

function sum(items, key) {
  return items.reduce((total, item) => total + (Number(item && item[key]) || 0), 0);
}

function ageMinutes(proc, now) {
  return proc.created == null ? 0 : (now - proc.created) / MS_PER_MINUTE;
}

module.exports = {
  TAIL_BYTES,
  MS_PER_MINUTE,
  claudeHome,
  cursorHome,
  stripBom,
  readJson,
  readTail,
  mtimeMs,
  listDir,
  normalizeCommand,
  normName,
  truncate,
  shortCommand,
  formatSpan,
  sum,
  ageMinutes,
};
