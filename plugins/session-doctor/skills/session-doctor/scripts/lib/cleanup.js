'use strict';
// Stops selected process groups. Every member is checked against a fresh snapshot right
// before it is stopped: if the PID now belongs to a process with another start time
// (the OS reused it), it is skipped.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { IS_WIN, stopPid, unixCreated } = require('./platform');

// Unix start times come from `ps etime` (1 s resolution), Windows ones are exact.
const SAME_PROCESS_TOLERANCE_MS = IS_WIN ? 2000 : 3000;

function sameProcess(live, member) {
  return live.created != null && member.created != null
    && Math.abs(live.created - member.created) <= SAME_PROCESS_TOLERANCE_MS;
}

// Windows stops are instant, so the fresh snapshot taken just before the loop is current.
// A Unix stop can wait seconds for SIGTERM, so each PID is checked again right before.
function defaultRecheck(pid) {
  return IS_WIN ? undefined : unixCreated(pid);
}

async function stopMember(member, liveByPid, protectedPids, { apply, recheck }) {
  if (member.keep || protectedPids.has(member.pid)) return 'skipped';
  const live = liveByPid.get(member.pid);
  if (!live) return 'gone';
  if (!sameProcess(live, member)) return 'skipped';
  if (!apply) return null;
  const created = recheck(member.pid);
  if (created === null) return 'gone';
  if (created !== undefined && !sameProcess({ created }, member)) return 'skipped';
  return stopPid(member.pid);
}

async function stopGroups(targets, freshProcesses, protectedPids, { apply = false, recheck = defaultRecheck } = {}) {
  const liveByPid = new Map(freshProcesses.map((p) => [p.pid, p]));
  const results = [];
  for (const target of targets) {
    const outcome = { killed: 0, gone: 0, skipped: 0, failed: 0 };
    for (const member of target.members) {
      const result = await stopMember(member, liveByPid, protectedPids, { apply, recheck });
      if (result) outcome[result] += 1;
    }
    results.push({ target, outcome });
  }
  return results;
}

function stateDir() {
  return path.join(os.homedir(), '.session-doctor');
}

// Private per-user directory: reports name sessions and hook commands.
function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!IS_WIN) fs.chmodSync(dir, 0o700);
  return dir;
}

function actionLogFile() {
  return path.join(stateDir(), 'actions.log');
}

function logAction(line) {
  ensureStateDir();
  fs.appendFileSync(actionLogFile(), `${new Date().toISOString()} ${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

function writePrivateFile(name, text) {
  const file = path.join(ensureStateDir(), name);
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
  if (!IS_WIN) fs.chmodSync(file, 0o600);
  return file;
}

module.exports = { sameProcess, stopGroups, actionLogFile, logAction, writePrivateFile };
