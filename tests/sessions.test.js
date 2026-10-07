'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lib, NOW, HOUR } = require('./helpers');

const { lastConversationTime, lastToolName, sessionState, registryMatches, transcriptActivity, sessionIdFromCommand } = lib('sessions');

const BASE = { isSelf: false, parentAlive: true, status: 'idle', now: NOW, staleHours: 12, hungMinutes: 30, headless: false, ageMinutes: 60 };

test('bookkeeping lines appended to idle transcripts are not activity', () => {
  const tail = [
    'ut-off partial line',
    '{"type":"user","timestamp":"2026-09-30T08:00:00.000Z","message":{}}',
    '{"type":"assistant","timestamp":"2026-09-30T08:05:00.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"Read"}]}}',
    '{"type":"artifact-autoreact-ledger","timestamp":"2026-10-06T16:40:00.000Z"}',
    '{"type":"custom-title","customTitle":"x"}',
  ].join('\n');
  assert.strictEqual(lastConversationTime(tail), Date.parse('2026-09-30T08:05:00.000Z'));
  assert.strictEqual(lastToolName(tail), 'Read');
  assert.strictEqual(lastConversationTime('{"type":"custom-title"}'), null);
});

test('session states', async (t) => {
  await t.test('self', () => assert.strictEqual(sessionState({ ...BASE, isSelf: true }), 'self'));
  await t.test('orphan-cli', () => assert.strictEqual(sessionState({ ...BASE, parentAlive: false }), 'orphan-cli'));
  await t.test('hung', () => assert.strictEqual(sessionState({ ...BASE, status: 'busy', lastActivity: NOW - 45 * 60000 }), 'hung'));
  await t.test('busy but recent', () => assert.strictEqual(sessionState({ ...BASE, status: 'busy', lastActivity: NOW - 5 * 60000 }), 'active'));
  await t.test('stale', () => assert.strictEqual(sessionState({ ...BASE, lastActivity: NOW - 13 * HOUR }), 'stale'));
  await t.test('recently idle', () => assert.strictEqual(sessionState({ ...BASE, lastActivity: NOW - 2 * HOUR }), 'active'));
  await t.test('no signal', () => assert.strictEqual(sessionState({ ...BASE, lastActivity: null }), 'unknown'));
  await t.test('old print-mode run', () => assert.strictEqual(sessionState({ ...BASE, lastActivity: null, headless: true, ageMinutes: 13 * 60 }), 'stale'));
});

test('registry entries must belong to the live process', () => {
  const created = NOW - HOUR;
  const fileTime = String((BigInt(created) + 11644473600000n) * 10000n);
  assert.ok(registryMatches({ procStart: fileTime }, { created }));
  assert.ok(!registryMatches({ procStart: '134000000000000000' }, { created }));
  assert.ok(registryMatches({ startedAt: created + 1500 }, { created }));
  assert.ok(!registryMatches({ startedAt: created - 10 * HOUR }, { created }));
});

test('session id from the command line', () => {
  assert.strictEqual(sessionIdFromCommand('claude', 'claude --resume 7cf5ff36-a5e7-44bb-9b78-a2fe7b04ac79'), '7cf5ff36-a5e7-44bb-9b78-a2fe7b04ac79');
  assert.strictEqual(sessionIdFromCommand('cursor', 'cursor-agent --resume=chat-1234abcd'), 'chat-1234abcd');
  assert.strictEqual(sessionIdFromCommand('claude', 'claude'), '');
});

test('a subagent written after its parent marks the activity and the stuck agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-tx-'));
  const main = path.join(dir, 'abc.jsonl');
  fs.writeFileSync(main, '{"type":"assistant","timestamp":"2026-10-01T10:00:00.000Z","message":{"content":[{"type":"tool_use","id":"t","name":"Agent"}]}}\n');
  const past = new Date('2026-10-01T10:00:00Z');
  fs.utimesSync(main, past, past);
  const subDir = path.join(dir, 'abc', 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), '{"type":"assistant","timestamp":"2026-10-01T10:20:00.000Z","message":{"content":[{"type":"tool_use","id":"t2","name":"Read"}]}}\n');
  fs.writeFileSync(path.join(subDir, 'agent-1.meta.json'), '{"agentType":"code-reviewer"}');
  const activity = transcriptActivity(main);
  assert.strictEqual(activity.subagent, 'code-reviewer');
  assert.strictEqual(activity.lastTool, 'Read');
  assert.strictEqual(activity.lastActivity, Date.parse('2026-10-01T10:20:00.000Z'));
});
