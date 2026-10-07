'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lib, proc } = require('./helpers');

const { buildIndex, liveParent, subtree, protectedSet } = lib('tree');

test('liveParent returns an older live parent', () => {
  const procs = [proc(1, 0, 'a', '', 10), proc(2, 1, 'b', '', 5)];
  assert.strictEqual(liveParent(procs[1], buildIndex(procs)).pid, 1);
});

test('liveParent is null when the parent is gone', () => {
  const procs = [proc(3, 9, 'c', '', 5)];
  assert.strictEqual(liveParent(procs[0], buildIndex(procs)), null);
});

test('liveParent is null when the parent PID was reused by a newer process', () => {
  const procs = [proc(4, 5, 'd', '', 5), proc(5, 1, 'e', '', 1)];
  assert.strictEqual(liveParent(procs[0], buildIndex(procs)), null);
});

test('liveParent is null when launchd/systemd adopted the process', () => {
  const procs = [proc(1, 0, 'launchd', '/sbin/launchd', 100), proc(6, 1, 'node', 'node mcp.js', 5)];
  assert.strictEqual(liveParent(procs[1], buildIndex(procs)), null);
});

test('subtree skips children that only look like children (reused PID)', () => {
  const procs = [proc(10, 1, 'root', '', 2), proc(11, 10, 'kid', '', 1), proc(12, 10, 'older', '', 5)];
  assert.deepStrictEqual(subtree(procs[0], buildIndex(procs)).map((p) => p.pid), [10, 11]);
});

test('subtree stops at other sessions', () => {
  const procs = [proc(10, 1, 'root', '', 2), proc(11, 10, 'cli', '', 1), proc(12, 11, 'mcp', '', 1)];
  assert.deepStrictEqual(subtree(procs[0], buildIndex(procs), new Set([11])).map((p) => p.pid), [10]);
});

test('protectedSet covers ancestors and the own session tree only', () => {
  const procs = [
    proc(100, 1, 'Claude', '', 10), proc(500, 100, 'claude', '', 2), proc(501, 500, 'node', '', 0.1),
    proc(502, 500, 'node', 'mcp', 2), proc(200, 100, 'claude', '', 5),
  ];
  const roles = new Map([[100, 'desktop-app'], [500, 'cli'], [501, 'other'], [502, 'mcp'], [200, 'cli']]);
  const { pids, selfCliPid } = protectedSet(buildIndex(procs), roles, 501, new Set([500, 200]));
  assert.strictEqual(selfCliPid, 500);
  for (const pid of [501, 500, 100, 502]) assert.ok(pids.has(pid), `protects ${pid}`);
  assert.ok(!pids.has(200));
});
