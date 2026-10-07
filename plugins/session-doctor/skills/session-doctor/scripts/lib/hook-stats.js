'use strict';
// Summarises the hook cost recorded in Claude Code transcripts (JSONL): per-hook
// latency, failures, timeouts, and how much of each transcript is hook output.

const fs = require('fs');
const readline = require('readline');

const PATH_TOKEN = /[^\s"'=]+\.(?:js|mjs|cjs|ts|py|sh|ps1|exe|cmd|bat)\b/gi;
const MB = 1048576;

function shortHookCommand(command) {
  const norm = String(command || '').replace(/\\/g, '/');
  const paths = norm.match(PATH_TOKEN);
  if (!paths) return norm.slice(0, 60);
  return paths[paths.length - 1].split('/').filter(Boolean).slice(-2).join('/');
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function hookAttachment(entry) {
  if (entry.type !== 'attachment' || !entry.attachment) return null;
  const type = entry.attachment.type || '';
  return type.startsWith('hook_') || type === 'async_hook_response' ? entry.attachment : null;
}

function isStopSummary(entry) {
  return entry.type === 'system' && entry.subtype === 'stop_hook_summary';
}

function record(acc, entry, attachment, bytes) {
  const key = `${attachment.hookEvent || '?'} ${shortHookCommand(attachment.command)}`;
  if (!acc.hooks[key]) acc.hooks[key] = { key, n: 0, durations: [], errors: 0, cancelled: 0, timeouts: 0, bytes: 0 };
  const stat = acc.hooks[key];
  stat.n += 1;
  stat.bytes += bytes;
  if (typeof attachment.durationMs === 'number') {
    stat.durations.push(attachment.durationMs);
    const day = String(entry.timestamp || '').slice(0, 10);
    if (day) (acc.daily[day] || (acc.daily[day] = [])).push(attachment.durationMs);
  }
  if (attachment.type === 'hook_cancelled') stat.cancelled += 1;
  const failedExit = typeof attachment.exitCode === 'number' && attachment.exitCode !== 0;
  if (failedExit || /error/.test(attachment.type)) stat.errors += 1;
  if (/ETIMEDOUT|timed out/i.test(String(attachment.stderr || ''))) stat.timeouts += 1;
}

async function scanFile(file, acc) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let totalBytes = 0;
  let hookBytes = 0;
  for await (const line of lines) {
    const bytes = line.length + 1;
    totalBytes += bytes;
    if (!line.includes('hook')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const attachment = hookAttachment(entry);
    if (attachment) record(acc, entry, attachment, bytes);
    if (attachment || isStopSummary(entry)) hookBytes += bytes;
  }
  return { file, mb: Math.round((totalBytes / MB) * 10) / 10, hookPercent: totalBytes ? Math.round((100 * hookBytes) / totalBytes) : 0 };
}

function summarise(acc, files) {
  const hooks = Object.values(acc.hooks).map((s) => {
    const d = s.durations.sort((a, b) => a - b);
    return {
      key: s.key,
      n: s.n,
      p50Ms: percentile(d, 0.5),
      p90Ms: percentile(d, 0.9),
      totalSec: Math.round(d.reduce((a, b) => a + b, 0) / 1000),
      errors: s.errors,
      cancelled: s.cancelled,
      timeouts: s.timeouts,
      mb: Math.round((s.bytes / MB) * 10) / 10,
    };
  }).sort((a, b) => b.totalSec - a.totalSec);
  const daily = Object.keys(acc.daily).sort().map((day) => {
    const d = acc.daily[day].sort((a, b) => a - b);
    return { day, n: d.length, p50Ms: percentile(d, 0.5), p90Ms: percentile(d, 0.9) };
  });
  return { files, hooks, daily };
}

async function analyzeFiles(paths) {
  const acc = { hooks: {}, daily: {} };
  const files = [];
  for (const file of paths) {
    try { files.push(await scanFile(file, acc)); } catch (err) { files.push({ file, error: err.message }); }
  }
  return summarise(acc, files);
}

module.exports = { shortHookCommand, percentile, analyzeFiles };
