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

test('cleanup without --apply is a dry run', () => {
  const result = run(['cleanup', '--category', CLEANUP_CATEGORIES.filter((c) => c !== 'unknown').join(',')]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY-RUN|Nothing matches/);
  assert.doesNotMatch(result.stdout, /^APPLY/m);
});
