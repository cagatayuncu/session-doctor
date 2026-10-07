'use strict';
// Everything that depends on the operating system: process snapshot, listening ports,
// machine load, spawn cost, stopping a process, and where the desktop app writes logs.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripBom, listDir } = require('./util');

const IS_WIN = process.platform === 'win32';
const FILETIME_EPOCH_OFFSET_MS = 11644473600000;
const MAX_BUFFER = 256 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120000;
const GB = 1024 * 1024 * 1024;
const KB_PER_GB = 1024 * 1024;
const TERM_GRACE_STEPS = 20;
const TERM_GRACE_STEP_MS = 100;
const SPAWN_RUNS = 3;

// One PowerShell start for processes, ports and load: process starts are what is slow here.
const WINDOWS_SNAPSHOT_SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$props = 'ProcessId','ParentProcessId','Name','CommandLine','CreationDate','WorkingSetSize'",
  '$procs = @(Get-CimInstance Win32_Process -Property $props | ForEach-Object { $t = 0; if ($_.CreationDate) { $t = $_.CreationDate.ToFileTimeUtc() }; [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; t = [string]$t; m = $_.WorkingSetSize } })',
  '$ports = @(); $portsOk = $true; try { $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ p = $_.OwningProcess; port = $_.LocalPort } }) } catch { $portsOk = $false }',
  '$cpu = (Get-CimInstance Win32_Processor -Property LoadPercentage | Measure-Object LoadPercentage -Average).Average',
  '$os = Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,FreePhysicalMemory',
  '[pscustomobject]@{ procs = $procs; ports = $ports; portsOk = $portsOk; cpu = $cpu; totalKb = $os.TotalVisibleMemorySize; freeKb = $os.FreePhysicalMemory } | ConvertTo-Json -Compress -Depth 4',
].join('; ');

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// FILETIME (100 ns since 1601) arrives as a string: it does not fit a JS number exactly.
function fileTimeToMs(value) {
  if (value == null || !/^\d{12,}$/.test(String(value))) return null;
  return Number(BigInt(String(value)) / 10000n) - FILETIME_EPOCH_OFFSET_MS;
}

function addPort(map, pid, port) {
  if (!Number.isFinite(pid) || !Number.isFinite(port)) return;
  if (!map.has(pid)) map.set(pid, []);
  if (!map.get(pid).includes(port)) map.get(pid).push(port);
}

function parseWindowsSnapshot(raw) {
  const data = JSON.parse(stripBom(String(raw).trim()));
  const processes = asArray(data.procs).map((p) => ({
    pid: Number(p.p),
    ppid: Number(p.pp),
    name: String(p.n || ''),
    cmd: String(p.c || ''),
    created: fileTimeToMs(p.t),
    mb: Math.round(Number(p.m || 0) / (1024 * 1024)),
  }));
  const ports = new Map();
  for (const entry of asArray(data.ports)) addPort(ports, Number(entry.p), Number(entry.port));
  const totalGb = Number(data.totalKb || 0) / KB_PER_GB;
  const freeGb = Number(data.freeKb || 0) / KB_PER_GB;
  return { processes, ports, portsKnown: data.portsOk !== false, load: makeLoad(Number(data.cpu || 0), totalGb, freeGb) };
}

// ps etime: [[dd-]hh:]mm:ss. null when unreadable: an unknown start time must not look
// like "just started", which would make the process's children look orphaned.
function parseEtime(text) {
  const match = String(text).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

// Two ps calls: names may contain spaces (macOS "Cursor Helper (Plugin)"), so the name
// and the full command line each have to be the last column of their own listing.
function parsePsOutput(statsText, commandsText, nowMs) {
  const commands = new Map();
  for (const line of String(commandsText).split('\n')) {
    const match = line.match(/^\s*(\d+)\s(.*)$/);
    if (match) commands.set(Number(match[1]), match[2].trim());
  }
  const processes = [];
  for (const line of String(statsText).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const elapsed = parseEtime(match[4]);
    processes.push({
      pid,
      ppid: Number(match[2]),
      name: path.basename(match[5].trim()),
      cmd: commands.get(pid) || match[5].trim(),
      created: elapsed == null ? null : nowMs - elapsed * 1000,
      mb: Math.round(Number(match[3]) / 1024),
    });
  }
  return processes;
}

function parseLsof(text) {
  const ports = new Map();
  let pid = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid != null) {
      const match = line.match(/:(\d+)$/);
      if (match) addPort(ports, pid, Number(match[1]));
    }
  }
  return ports;
}

function parseSs(text) {
  const ports = new Map();
  for (const line of String(text).split('\n')) {
    const portMatch = line.match(/^\S+\s+\d+\s+\d+\s+\S*:(\d+)\s/);
    if (!portMatch) continue;
    for (const pidMatch of line.matchAll(/pid=(\d+)/g)) addPort(ports, Number(pidMatch[1]), Number(portMatch[1]));
  }
  return ports;
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: COMMAND_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function makeLoad(cpuPercent, totalGb, freeGb) {
  return {
    cpuPercent: Math.round(cpuPercent),
    cores: os.cpus().length,
    memTotalGb: Math.round(totalGb * 10) / 10,
    memFreeGb: Math.round(freeGb * 10) / 10,
    memUsedPercent: totalGb > 0 ? Math.round((100 * (totalGb - freeGb)) / totalGb) : 0,
  };
}

function tryRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
  return { ok: !result.error, status: result.status, stdout: result.stdout || '' };
}

// { ports, known }. lsof exits 1 when nothing listens; that is an answer, not a failure.
function unixListeningPorts() {
  const lsof = tryRun('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']);
  if (lsof.ok && (lsof.status === 0 || (lsof.status === 1 && lsof.stdout.trim() === ''))) {
    return { ports: parseLsof(lsof.stdout), known: true };
  }
  const ss = tryRun('ss', ['-ltnpH']);
  if (ss.ok && ss.status === 0) return { ports: parseSs(ss.stdout), known: true };
  return { ports: new Map(), known: false };
}

function snapshotWindows() {
  const raw = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SNAPSHOT_SCRIPT]);
  return parseWindowsSnapshot(raw);
}

function snapshotUnix({ withPorts = true } = {}) {
  const now = Date.now();
  const stats = run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,rss=,etime=,comm=']);
  const commands = run('ps', ['-A', '-ww', '-o', 'pid=,command=']);
  const cpuPercent = (100 * os.loadavg()[0]) / Math.max(1, os.cpus().length);
  const listening = withPorts ? unixListeningPorts() : { ports: new Map(), known: false };
  return {
    processes: parsePsOutput(stats, commands, now),
    ports: listening.ports,
    portsKnown: listening.known,
    load: makeLoad(cpuPercent, os.totalmem() / GB, os.freemem() / GB),
  };
}

// Start time of one Unix process right now (ms), or null when it is gone.
function unixCreated(pid) {
  const result = tryRun('ps', ['-o', 'etime=', '-p', String(pid)]);
  const elapsed = result.ok && result.status === 0 ? parseEtime(result.stdout) : null;
  return elapsed == null ? null : Date.now() - elapsed * 1000;
}

function isZombie(pid) {
  const result = tryRun('ps', ['-o', 'stat=', '-p', String(pid)]);
  return result.ok && result.stdout.trim().startsWith('Z');
}

function snapshot(options = {}) {
  return IS_WIN ? snapshotWindows() : snapshotUnix(options);
}

function findGitBash() {
  const candidates = [process.env.CLAUDE_CODE_GIT_BASH_PATH];
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

function medianSpawnMs(command, args) {
  const times = [];
  for (let i = 0; i < SPAWN_RUNS; i += 1) {
    const start = process.hrtime.bigint();
    spawnSync(command, args, { stdio: 'ignore', windowsHide: true, timeout: COMMAND_TIMEOUT_MS });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(SPAWN_RUNS / 2)]);
}

// Agents run each hook command through a shell (Git Bash on Windows), so one hook costs
// about one shell start plus one interpreter start.
function spawnCost() {
  const shell = IS_WIN ? findGitBash() : '/bin/sh';
  return {
    nodeMs: medianSpawnMs(process.execPath, ['-e', '0']),
    shellMs: shell ? medianSpawnMs(shell, ['-c', 'exit 0']) : null,
    shell: shell ? path.basename(shell) : null,
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Windows: SIGTERM terminates at once. Unix: SIGTERM, then SIGKILL after a short grace.
async function stopPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    return err.code === 'ESRCH' ? 'gone' : 'failed';
  }
  if (IS_WIN) return 'killed';
  for (let i = 0; i < TERM_GRACE_STEPS; i += 1) {
    await sleep(TERM_GRACE_STEP_MS);
    if (!isAlive(pid)) return 'killed';
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  await sleep(TERM_GRACE_STEP_MS);
  // A zombie has exited and only waits for its parent to reap it.
  return !isAlive(pid) || isZombie(pid) ? 'killed' : 'failed';
}

function desktopLogCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Logs', 'Claude', 'main.log')];
  if (!IS_WIN) return [path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'logs', 'main.log')];
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const packaged = listDir(path.join(local, 'Packages'), { dirs: true })
    .filter((d) => path.basename(d).startsWith('Claude_'))
    .map((d) => path.join(d, 'LocalCache', 'Local', 'Claude', 'Logs', 'main.log'));
  return [path.join(local, 'Claude', 'Logs', 'main.log'), path.join(roaming, 'Claude', 'logs', 'main.log'), ...packaged];
}

function cursorEnterpriseHooksFile() {
  if (IS_WIN) return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Cursor', 'hooks.json');
  if (process.platform === 'darwin') return '/Library/Application Support/Cursor/hooks.json';
  return '/etc/cursor/hooks.json';
}

module.exports = {
  IS_WIN,
  fileTimeToMs,
  parseWindowsSnapshot,
  parseEtime,
  parsePsOutput,
  parseLsof,
  parseSs,
  snapshot,
  spawnCost,
  stopPid,
  isAlive,
  unixCreated,
  desktopLogCandidates,
  cursorEnterpriseHooksFile,
};
