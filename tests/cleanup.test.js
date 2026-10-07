'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const { lib } = require('./helpers');

const { stopGroups } = lib('cleanup');
const { isAlive } = lib('platform');

function startSleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
}

function group(pid, created) {
  return { category: 'orphan-agent', pid, members: [{ pid, created }] };
}

test('stopGroups verifies every PID against a fresh snapshot', async (t) => {
  const child = startSleeper();
  const created = Date.now();
  const live = [{ pid: child.pid, created }];
  t.after(() => { if (isAlive(child.pid)) child.kill('SIGKILL'); });

  await t.test('a dry run stops nothing', async () => {
    const [{ outcome }] = await stopGroups([group(child.pid, created)], live, new Set());
    assert.strictEqual(outcome.killed, 0);
    assert.ok(isAlive(child.pid));
  });
  await t.test('a PID whose start time no longer matches is skipped', async () => {
    const [{ outcome }] = await stopGroups([group(child.pid, created - 3600000)], live, new Set(), { apply: true });
    assert.strictEqual(outcome.skipped, 1);
    assert.ok(isAlive(child.pid));
  });
  await t.test('protected PIDs are skipped', async () => {
    const [{ outcome }] = await stopGroups([group(child.pid, created)], live, new Set([child.pid]), { apply: true });
    assert.strictEqual(outcome.skipped, 1);
  });
  await t.test('a process missing from the fresh snapshot counts as gone', async () => {
    const [{ outcome }] = await stopGroups([group(child.pid, created)], [], new Set(), { apply: true });
    assert.strictEqual(outcome.gone, 1);
  });
  await t.test('members marked keep are never stopped', async () => {
    const kept = { category: 'stale', pid: child.pid, members: [{ pid: child.pid, created, keep: true }] };
    const [{ outcome }] = await stopGroups([kept], live, new Set(), { apply: true });
    assert.strictEqual(outcome.skipped, 1);
    assert.ok(isAlive(child.pid));
  });
  await t.test('the last re-check right before stopping wins', async () => {
    const gone = await stopGroups([group(child.pid, created)], live, new Set(), { apply: true, recheck: () => null });
    assert.strictEqual(gone[0].outcome.gone, 1);
    const reused = await stopGroups([group(child.pid, created)], live, new Set(), { apply: true, recheck: () => created + 3600000 });
    assert.strictEqual(reused[0].outcome.skipped, 1);
    assert.ok(isAlive(child.pid));
  });
  await t.test('a verified process is stopped with apply', async () => {
    const exited = new Promise((resolve) => { child.on('exit', resolve); });
    const [{ outcome }] = await stopGroups([group(child.pid, created)], live, new Set(), { apply: true });
    assert.strictEqual(outcome.killed, 1);
    await exited;
  });
});
