'use strict';
// End-to-end against the real machine: read-only diagnose and dry-run cleanup only.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { CLI, lib } = require('./helpers');

const { parseArgs, UsageError } = require(CLI);
const { CLEANUP_CATEGORIES } = lib('classify');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 300000, windowsHide: true });
}

test('argument parsing', () => {
  const opts = parseArgs(['cleanup', '--category', 'stale,hung', '--only', '12,34', '--stale-hours', '6', '--apply']);
  assert.deepStrictEqual(opts.category, ['stale', 'hung']);
  assert.deepStrictEqual(opts.only, [12, 34]);
  assert.strictEqual(opts.staleHours, 6);
  assert.strictEqual(opts.apply, true);
  assert.throws(() => parseArgs(['diagnose', '--stale-hours', '-1']), UsageError);
  assert.throws(() => parseArgs(['diagnose', '--bogus']), UsageError);
  assert.throws(() => parseArgs(['cleanup', '--only', 'abc']), UsageError);
});

test('diagnose --json --quick runs on this machine', () => {
  const result = run(['diagnose', '--json', '--quick']);
  assert.strictEqual(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  for (const key of ['sessions', 'orphans', 'stuckHooks', 'terminals', 'ideHosts', 'hotPath', 'load', 'probes']) {
    assert.ok(key in data, `has ${key}`);
  }
  assert.ok(data.load.cores > 0);
});

test('cleanup refuses unclear requests', () => {
  assert.strictEqual(run(['cleanup']).status, 2);
  assert.strictEqual(run(['cleanup', '--category', 'everything']).status, 2);
  assert.strictEqual(run(['cleanup', '--category', 'unknown']).status, 2);
});

function isolatedHome() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  const runIn = (args, cli = CLI) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 300000, windowsHide: true, env });
  return { fs, path, home, runIn };
}

test('status prints one line; hook mode stays quiet unless it has something to say', () => {
  const { runIn } = isolatedHome();
  const plain = runIn(['status', '--max-age-minutes', '1']);
  assert.strictEqual(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^session-doctor: /);
  const hook = runIn(['status', '--hook', 'claude']);
  assert.strictEqual(hook.status, 0, hook.stderr);
  if (hook.stdout.trim()) assert.ok(JSON.parse(hook.stdout).systemMessage);
});

test('hook install/uninstall in an isolated home', () => {
  const { fs, path, home, runIn } = isolatedHome();
  const settings = path.join(home, '.claude', 'settings.json');

  const dry = runIn(['hook', 'install']);
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would add the SessionStart hook to .*settings\.json/);
  assert.ok(!fs.existsSync(settings), 'a dry run writes nothing');

  const applied = runIn(['hook', 'install', '--apply']);
  assert.strictEqual(applied.status, 0, applied.stderr);
  const hookCmd = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.SessionStart[0].hooks[0].command;
  assert.match(hookCmd, /\.session-doctor\/bin\/session-doctor\.js' status --hook claude$/);
  const copied = path.join(home, '.session-doctor', 'bin', 'session-doctor.js');
  const fromCopy = runIn(['status', '--hook', 'claude'], copied);
  assert.strictEqual(fromCopy.status, 0, fromCopy.stderr);
  const again = runIn(['hook', 'install', '--apply'], copied);
  assert.strictEqual(again.status, 0, again.stderr);
  assert.ok(fs.existsSync(copied), 'reinstalling from the installed copy keeps it');

  const removed = runIn(['hook', 'uninstall', '--apply']);
  assert.strictEqual(removed.status, 0, removed.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {});
  assert.ok(!fs.existsSync(copied), 'uninstall removes the script copy');
  assert.ok(fs.readdirSync(path.join(home, '.claude')).some((f) => f.startsWith('settings.json.bak-session-doctor-')));
  assert.strictEqual(runIn(['hook']).status, 2);
});

test('cleanup without --apply is a dry run', () => {
  const result = run(['cleanup', '--category', CLEANUP_CATEGORIES.filter((c) => c !== 'unknown').join(',')]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY-RUN|Nothing matches/);
  assert.doesNotMatch(result.stdout, /^APPLY/m);
});
