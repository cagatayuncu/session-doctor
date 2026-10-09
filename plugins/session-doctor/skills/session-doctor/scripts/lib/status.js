'use strict';
// One-line health check for the start of a session: is anything worth cleaning up?
// Used by `status`, and by the opt-in SessionStart hook that `hook install` sets up.

const fs = require('fs');
const path = require('path');

const WARN_STALE_SESSIONS = 3;
const WARN_RECLAIM_MB = 2048;
const MB_PER_GB = 1024;

function size(mb) {
  return mb >= MB_PER_GB ? `${(mb / MB_PER_GB).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// { warn, text } from a summary (see summary.js).
function findings(summary) {
  const parts = [];
  const { safe, orphanTasks, candidates, reclaim } = summary;
  if (safe.count) parts.push(`${safe.count} leaked agent process group${safe.count === 1 ? '' : 's'}`);
  if (candidates.hung.count) parts.push(`${candidates.hung.count} hung session${candidates.hung.count === 1 ? '' : 's'}`);
  if (candidates['orphan-cli'].count) parts.push(`${candidates['orphan-cli'].count} orphaned agent CLI${candidates['orphan-cli'].count === 1 ? '' : 's'}`);
  if (candidates.stale.count) parts.push(`${candidates.stale.count} stale session${candidates.stale.count === 1 ? '' : 's'}`);
  if (orphanTasks.count) parts.push(`${orphanTasks.count} leftover background job${orphanTasks.count === 1 ? '' : 's'}`);
  // status skips the port scan for speed, which moves orphaned MCP servers from "safe" to
  // "leftover background job", so both count as something to warn about.
  const warn = safe.count > 0 || orphanTasks.count > 0 || candidates.hung.count > 0 || candidates['orphan-cli'].count > 0
    || candidates.stale.count >= WARN_STALE_SESSIONS || reclaim.mb >= WARN_RECLAIM_MB;
  const text = parts.length
    ? `session-doctor: ${parts.join(', ')}; about ${size(reclaim.mb)} could be freed. Ask to "run session doctor" to review and clean up.`
    : `session-doctor: nothing to clean up (${summary.sessions.count} sessions, ${size(summary.sessions.mb)}).`;
  return { warn, text };
}

// What a SessionStart hook prints. Claude Code shows systemMessage to the user and gives
// additionalContext to Claude; Cursor only takes additional_context for the agent.
function hookOutput(agent, finding) {
  if (!finding.warn) return '';
  const context = `${finding.text} The session-doctor skill can diagnose this; offer it if the user wants, do not run cleanup unasked.`;
  if (agent === 'cursor') return JSON.stringify({ additional_context: context });
  return JSON.stringify({ systemMessage: finding.text, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
}

// The cache is only valid for the same thresholds, and never for a time in the future.
function readCache(file, maxAgeMs, key = '', now = Date.now()) {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = now - cached.at;
    return cached && cached.key === key && age >= 0 && age <= maxAgeMs ? cached.finding : null;
  } catch {
    return null;
  }
}

function writeCache(file, finding, key = '', now = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ at: now, key, finding }), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // A status check must never fail because its cache could not be written.
  }
}

function clearCache(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* nothing to clear */ }
}

// A failed check is remembered like a quiet one, so a broken snapshot does not slow every session start.
const FAILED = { warn: false, text: 'session-doctor: the status check failed; run diagnose for details.' };

module.exports = { WARN_STALE_SESSIONS, WARN_RECLAIM_MB, FAILED, findings, hookOutput, readCache, writeCache, clearCache };
