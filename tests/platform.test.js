'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lib } = require('./helpers');

const { parseWindowsSnapshot, parseEtime, parsePsOutput, parseLsof, parseSs, fileTimeToMs } = lib('platform');

test('FILETIME strings keep full precision', () => {
  assert.strictEqual(fileTimeToMs('134357689015989080'), 1791295301598);
  assert.strictEqual(fileTimeToMs('0'), null);
  assert.strictEqual(fileTimeToMs(undefined), null);
});

test('Windows snapshot JSON (single process and port come back as objects)', () => {
  const raw = '﻿{"procs":{"p":42,"pp":1,"n":"node.exe","c":"node x.js","t":"134357689015989080","m":10485760},"ports":{"p":42,"port":5173},"cpu":39,"totalKb":65736000,"freeKb":12000000}';
  const snap = parseWindowsSnapshot(raw);
  assert.deepStrictEqual(snap.processes, [{ pid: 42, ppid: 1, name: 'node.exe', cmd: 'node x.js', created: 1791295301598, mb: 10 }]);
  assert.deepStrictEqual(snap.ports.get(42), [5173]);
  assert.strictEqual(snap.load.cpuPercent, 39);
  assert.ok(snap.load.memUsedPercent > 70);
});

test('ps etime formats', () => {
  assert.strictEqual(parseEtime('03:04'), 184);
  assert.strictEqual(parseEtime('02:03:04'), 7384);
  assert.strictEqual(parseEtime('1-02:03:04'), 93784);
  assert.strictEqual(parseEtime('garbage'), null);
});

test('an unreadable start time stays unknown instead of "just started"', () => {
  const [p] = parsePsOutput('  7  1  100  ??:??  node\n', '  7 node x.js\n', 5000);
  assert.strictEqual(p.created, null);
});

test('Windows snapshot reports whether ports could be read', () => {
  const raw = (ok) => JSON.stringify({ procs: [], ports: [], portsOk: ok, cpu: 1, totalKb: 1, freeKb: 1 });
  assert.strictEqual(parseWindowsSnapshot(raw(true)).portsKnown, true);
  assert.strictEqual(parseWindowsSnapshot(raw(false)).portsKnown, false);
});

test('ps output with spaces in names and commands', () => {
  const now = 1_000_000_000;
  const stats = [
    '    1     0  1200    10-00:00:00 /sbin/launchd',
    '  812     1 409600       01:00:00 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)',
    ' 4242   812  51200          05:00 node',
  ].join('\n');
  const commands = [
    '    1 /sbin/launchd',
    '  812 /Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin) --type=utility',
    ' 4242 node /Users/u/mcp/server.js --stdio',
  ].join('\n');
  const procs = parsePsOutput(stats, commands, now);
  assert.strictEqual(procs.length, 3);
  assert.strictEqual(procs[1].name, 'Cursor Helper (Plugin)');
  assert.match(procs[1].cmd, /--type=utility$/);
  assert.strictEqual(procs[2].cmd, 'node /Users/u/mcp/server.js --stdio');
  assert.strictEqual(procs[2].created, now - 300 * 1000);
  assert.strictEqual(procs[2].mb, 50);
});

test('listening ports from lsof and ss', () => {
  assert.deepStrictEqual(parseLsof('p123\nn*:5173\nn[::1]:5173\np456\nn127.0.0.1:8080\n').get(123), [5173]);
  const ss = 'LISTEN 0      511          0.0.0.0:5173      0.0.0.0:*    users:(("node",pid=1234,fd=20))\n';
  assert.deepStrictEqual(parseSs(ss).get(1234), [5173]);
});
