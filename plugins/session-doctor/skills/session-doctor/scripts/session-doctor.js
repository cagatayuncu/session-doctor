#!/usr/bin/env node
'use strict';
// session-doctor: find and safely stop leaked AI-agent processes (Claude Code, Cursor
// and other agent CLIs) and measure the hook overhead that slows every tool call.
// Zero dependencies; Node.js 18+; Windows, macOS and Linux.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { claudeHome, cursorHome } = require('./lib/util');
const { snapshot, spawnCost } = require('./lib/platform');
const { loadHookConfig, hotPath } = require('./lib/hooks');
const { loadRegistry, transcriptIndex, cursorChatIndex, isGitWorktreePath } = require('./lib/sessions');
const { DEFAULTS, CLEANUP_CATEGORIES, buildContext, classify, selectTargets } = require('./lib/classify');
const { stopGroups, logAction, actionLogFile, writePrivateFile } = require('./lib/cleanup');
const { desktopTimeouts, transcriptSummary, hookDisableVars, worktreeChanges } = require('./lib/probes');
const { analyzeFiles } = require('./lib/hook-stats');
const { render } = require('./lib/report');
const { summarize } = require('./lib/summary');
const status = require('./lib/status');
const install = require('./lib/install');

const USAGE = `Usage:
  node session-doctor.js diagnose [--quick] [--json] [thresholds] [--timeout-hours N] [--project DIR]
  node session-doctor.js cleanup --category <list> [--only <pid,...>] [--apply] [thresholds]
  node session-doctor.js status [--hook claude|cursor] [--max-age-minutes N]
  node session-doctor.js hook install|uninstall [--agent claude|cursor|all] [--apply]

Thresholds: --stale-hours N (${DEFAULTS.staleHours}), --hung-minutes N (${DEFAULTS.hungMinutes}), --hook-max-minutes N (${DEFAULTS.hookMaxMinutes})
Categories: ${CLEANUP_CATEGORIES.join(', ')}
diagnose and status are read-only. cleanup and hook are dry runs unless --apply is given.`;
const DEFAULT_TIMEOUT_HOURS = 48;
const DEFAULT_STATUS_MAX_AGE_MINUTES = 10;
const STATUS_SNAPSHOT_TIMEOUT_MS = 20000;
const WORKTREE_STATES = new Set(['stale', 'hung', 'orphan-cli']);
const HOOK_AGENTS = ['claude', 'cursor'];

class UsageError extends Error {}

function positiveNumber(flag, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} needs a positive number, got "${value}"`);
  return n;
}

function pidList(value) {
  const pids = String(value).split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (pids.length === 0 || pids.some((p) => !Number.isInteger(p) || p <= 0)) throw new UsageError(`--only needs PIDs like 123,456, got "${value}"`);
  return pids;
}

function oneOf(flag, value, allowed) {
  if (!allowed.includes(value)) throw new UsageError(`${flag} must be one of ${allowed.join(', ')}, got "${value}"`);
  return value;
}

function parseArgs(argv) {
  const [command = 'help', ...afterCommand] = argv;
  const subcommand = command === 'hook' ? afterCommand[0] : null;
  const rest = command === 'hook' ? afterCommand.slice(1) : afterCommand;
  const opts = {
    command, subcommand, quick: false, json: false, apply: false, category: [], only: [], project: process.cwd(),
    staleHours: DEFAULTS.staleHours, hungMinutes: DEFAULTS.hungMinutes, hookMaxMinutes: DEFAULTS.hookMaxMinutes,
    timeoutHours: DEFAULT_TIMEOUT_HOURS, maxAgeMinutes: DEFAULT_STATUS_MAX_AGE_MINUTES, hook: null, agent: 'all',
  };
  const flags = { '--quick': 'quick', '--json': 'json', '--apply': 'apply' };
  const numbers = {
    '--stale-hours': 'staleHours', '--hung-minutes': 'hungMinutes', '--hook-max-minutes': 'hookMaxMinutes',
    '--timeout-hours': 'timeoutHours', '--max-age-minutes': 'maxAgeMinutes',
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return rest[i];
    };
    if (arg === '-h' || arg === '--help') opts.command = 'help';
    else if (flags[arg]) opts[flags[arg]] = true;
    else if (numbers[arg]) opts[numbers[arg]] = positiveNumber(arg, value());
    else if (arg === '--category') opts.category = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--only') opts.only = pidList(value());
    else if (arg === '--project') opts.project = path.resolve(value());
    else if (arg === '--hook') opts.hook = oneOf(arg, value(), HOOK_AGENTS);
    else if (arg === '--agent') opts.agent = oneOf(arg, value(), [...HOOK_AGENTS, 'all']);
    else throw new UsageError(`unknown option ${arg}`);
  }
  if (command === 'hook' && !['install', 'uninstall'].includes(subcommand)) throw new UsageError('hook needs install or uninstall');
  return opts;
}

function collect(opts, { withPorts = true, timeoutMs } = {}) {
  const claude = claudeHome();
  const cursor = cursorHome();
  const snap = snapshot({ withPorts, timeoutMs });
  const hookConfig = loadHookConfig({ claudeHome: claude, cursorHome: cursor, projectDir: opts.project });
  const ctx = buildContext({
    processes: snap.processes,
    hookConfig,
    registry: loadRegistry(claude),
    transcripts: transcriptIndex(claude),
    cursorChats: cursorChatIndex(cursor),
    ports: snap.ports,
    portsKnown: snap.portsKnown,
    selfPid: process.pid,
    staleHours: opts.staleHours,
    hungMinutes: opts.hungMinutes,
    hookMaxMinutes: opts.hookMaxMinutes,
  });
  const result = classify(ctx);
  for (const s of result.sessions) {
    if (WORKTREE_STATES.has(s.state) && isGitWorktreePath(s.cwd)) s.uncommitted = worktreeChanges(s.cwd);
  }
  return {
    ...result, generatedAt: ctx.now, platform: process.platform, load: snap.load, portsKnown: snap.portsKnown,
    hotPath: hotPath(hookConfig), hookConfig, protectedPids: ctx.protected,
  };
}

async function gatherProbes(opts) {
  const claude = claudeHome();
  const probes = { timeouts: desktopTimeouts(opts.timeoutHours).rows, disableVars: hookDisableVars(claude), spawn: null, transcripts: null, hookStats: null };
  if (fs.existsSync(path.join(claude, 'projects'))) probes.transcripts = transcriptSummary(claude);
  if (!opts.quick) {
    probes.spawn = spawnCost();
    if (probes.transcripts) probes.hookStats = await analyzeFiles(probes.transcripts.recent);
  }
  return probes;
}

async function diagnose(opts) {
  const d = collect(opts);
  const probes = await gatherProbes(opts);
  const { protectedPids, ...serializable } = d;
  const data = { ...serializable, summary: summarize(d), probes };
  const file = writePrivateFile('diagnosis.json', JSON.stringify(data, null, 2));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
    return;
  }
  process.stdout.write(`${render(d, probes, { ...opts, script: __filename })}\n\nFull data: ${file}\n`);
}

function targetLabel(target) {
  return target.state ? (target.title || target.command) : (target.workload || target.command);
}

function validateCleanup(opts) {
  if (opts.category.length === 0) throw new UsageError('cleanup needs --category');
  const unknown = opts.category.filter((c) => !CLEANUP_CATEGORIES.includes(c));
  if (unknown.length) throw new UsageError(`unknown category: ${unknown.join(', ')}`);
  if (opts.category.includes('unknown') && opts.only.length === 0) {
    throw new UsageError("category 'unknown' has no activity signal; name the sessions with --only <pid,...>");
  }
}

async function cleanup(opts) {
  validateCleanup(opts);
  const d = collect(opts);
  const targets = selectTargets(d, opts.category, opts.only, d.protectedPids);
  const missing = opts.only.filter((pid) => !targets.some((t) => t.pid === pid));
  if (missing.length) process.stderr.write(`Not in the requested categories now (left alone): ${missing.join(',')}\n`);
  if (targets.length === 0) {
    process.stdout.write('Nothing matches; no process was touched.\n');
    return;
  }
  const mode = opts.apply ? 'APPLY' : 'DRY-RUN';
  const results = await stopGroups(targets, snapshot({ withPorts: false }).processes, d.protectedPids, { apply: opts.apply });
  const total = { killed: 0, gone: 0, skipped: 0, failed: 0 };
  for (const { target, outcome } of results) {
    for (const key of Object.keys(total)) total[key] += outcome[key];
    const line = `${mode} ${target.category} pid=${target.pid} procs=${target.procs} mb=${target.mb} killed=${outcome.killed} gone=${outcome.gone} skipped=${outcome.skipped} failed=${outcome.failed} :: ${targetLabel(target)}`;
    process.stdout.write(`${line}\n`);
    if (opts.apply) logAction(line);
  }
  if (opts.apply) status.clearCache(statusCacheFile());
  process.stdout.write(`\n${mode}: ${results.length} groups. killed=${total.killed} already-gone=${total.gone} skipped=${total.skipped} failed=${total.failed}\n`);
  process.stdout.write(opts.apply ? `Logged to ${actionLogFile()}. Run diagnose --quick to confirm.\n` : 'Nothing was stopped. Re-run with --apply to act.\n');
}

function statusCacheFile() {
  return path.join(os.homedir(), '.session-doctor', 'status.json');
}

// Fast and quiet: no ports, no transcript statistics, a short snapshot timeout and a
// short-lived cache keyed by the thresholds. In hook mode it prints only when there is
// something to say, and a failure is cached too, so it never slows or breaks session start.
function freshFinding(opts) {
  const key = `${opts.staleHours}/${opts.hungMinutes}/${opts.hookMaxMinutes}/${opts.project}`;
  const cached = status.readCache(statusCacheFile(), opts.maxAgeMinutes * 60000, key);
  if (cached) return cached;
  let finding;
  try {
    finding = status.findings(summarize(collect(opts, { withPorts: false, timeoutMs: STATUS_SNAPSHOT_TIMEOUT_MS })));
  } catch (err) {
    if (!opts.hook) throw err;
    finding = status.FAILED;
  }
  status.writeCache(statusCacheFile(), finding, key);
  return finding;
}

function statusCommand(opts) {
  try {
    const finding = freshFinding(opts);
    const out = opts.hook ? status.hookOutput(opts.hook, finding) : finding.text;
    if (out) process.stdout.write(`${out}\n`);
  } catch (err) {
    if (!opts.hook) throw err; // in hook mode a health check must never break session start
  }
}

function hookCommand(opts) {
  const homes = { claudeHome: claudeHome(), cursorHome: cursorHome() };
  const binDir = path.join(os.homedir(), '.session-doctor', 'bin');
  const agents = opts.agent === 'all' ? HOOK_AGENTS : [opts.agent];
  const changes = install.plan(opts.subcommand, agents, homes, binDir);
  if (changes.length === 0) {
    process.stdout.write('Neither Claude Code nor Cursor settings were found; nothing to do.\n');
    return;
  }
  const verb = opts.subcommand === 'install' ? 'add the SessionStart hook to' : 'remove the SessionStart hook from';
  for (const c of changes) {
    process.stdout.write(`${opts.apply ? '' : 'Would '}${c.changed ? verb : 'leave unchanged'} ${c.file}\n`);
  }
  if (opts.subcommand === 'install') process.stdout.write(`${opts.apply ? 'Copying' : 'Would copy'} the scripts to ${binDir} (the hook runs that copy, so plugin updates cannot break it)\n`);
  if (!opts.apply) {
    process.stdout.write('Nothing was changed. Re-run with --apply to do it.\n');
    return;
  }
  const installing = opts.subcommand === 'install';
  const backups = install.apply(changes, { scriptsDir: __dirname, binDir, copy: installing });
  for (const b of backups) process.stdout.write(`Backup: ${b}\n`);
  status.clearCache(statusCacheFile());
  if (installing) {
    process.stdout.write(`Done. Remove it any time with: node "${path.join(binDir, 'session-doctor.js')}" hook uninstall --apply\n`);
    return;
  }
  // The copy is only needed by the hook; keep it while another agent's hook still points at it.
  const stillUsed = install.plan('uninstall', HOOK_AGENTS.filter((a) => !agents.includes(a)), homes, binDir).some((c) => c.changed);
  const runningFromCopy = install.isRunningFrom(__dirname, binDir);
  if (!stillUsed && !runningFromCopy) install.removeScripts(binDir);
  if (stillUsed) process.stdout.write('Done. The script copy stays: the other agent\'s hook still uses it.\n');
  else if (runningFromCopy) process.stdout.write(`Done. Delete ${binDir} yourself; it is the copy running this command.\n`);
  else process.stdout.write('Done.\n');
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === 'diagnose') return diagnose(opts);
  if (opts.command === 'cleanup') return cleanup(opts);
  if (opts.command === 'status') return statusCommand(opts);
  if (opts.command === 'hook') return hookCommand(opts);
  if (opts.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return undefined;
  }
  throw new UsageError(`unknown command ${opts.command}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}\n`);
      process.exit(2);
    }
    process.stderr.write(`session-doctor failed: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, UsageError };
