'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { lib, CLI } = require('./helpers');

const { skillTargets, autoAgent, inspectTarget, installSkill, uninstallSkill } = lib('skill-install');
const { parseArgs } = require(CLI);

const SKILL_DIR = path.join(path.dirname(CLI), '..');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sd-skill-'));
}

test('targets and automatic choice', () => {
  const root = tempRoot();
  const homes = { claudeHome: path.join(root, '.claude'), cursorHome: path.join(root, '.cursor'), home: root };
  assert.strictEqual(skillTargets(homes).agents, path.join(root, '.agents', 'skills', 'session-doctor'));
  assert.strictEqual(autoAgent(homes), 'agents');
  fs.mkdirSync(homes.cursorHome);
  assert.strictEqual(autoAgent(homes), 'cursor');
  fs.mkdirSync(homes.claudeHome);
  assert.strictEqual(autoAgent(homes), 'claude', 'Cursor reads ~/.claude/skills too');
});

test('install, update and uninstall a copied skill', () => {
  const target = path.join(tempRoot(), 'skills', 'session-doctor');
  assert.strictEqual(installSkill(SKILL_DIR, target), 'installed');
  assert.ok(fs.existsSync(path.join(target, 'scripts', 'session-doctor.js')));
  assert.strictEqual(inspectTarget(target), 'ours');
  assert.strictEqual(installSkill(SKILL_DIR, target), 'updated');
  assert.strictEqual(installSkill(target, target), 'already', 'running from the installed copy');
  assert.strictEqual(uninstallSkill(target), 'removed');
  assert.strictEqual(uninstallSkill(target), 'absent');
});

test('someone else\'s folder and links are never replaced or removed', () => {
  const root = tempRoot();
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, 'SKILL.md'), '---\nname: other-skill\n---\n');
  assert.throws(() => installSkill(SKILL_DIR, foreign), /not session-doctor/);
  assert.throws(() => uninstallSkill(foreign), /not session-doctor/);
  assert.ok(fs.existsSync(path.join(foreign, 'SKILL.md')));

  const link = path.join(root, 'link');
  fs.symlinkSync(SKILL_DIR, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.strictEqual(inspectTarget(link), 'link');
  assert.throws(() => installSkill(SKILL_DIR, link), /is a link/);
  assert.throws(() => uninstallSkill(link), /is a link/);
  assert.ok(fs.existsSync(path.join(SKILL_DIR, 'SKILL.md')), 'the link target is untouched');
});

test('no command means diagnose; install takes its own agent names', () => {
  assert.strictEqual(parseArgs([]).command, 'diagnose');
  assert.strictEqual(parseArgs(['--quick']).quick, true);
  assert.strictEqual(parseArgs(['--help']).command, 'help');
  assert.strictEqual(parseArgs(['install', '--agent', 'agents']).agent, 'agents');
  assert.strictEqual(parseArgs(['hook', 'install']).agent, 'all');
  assert.throws(() => parseArgs(['install', '--agent', 'all']));
  assert.throws(() => parseArgs(['hook', 'install', '--agent', 'agents']));
});

test('the install command copies the skill into an isolated home', () => {
  const home = tempRoot();
  fs.mkdirSync(path.join(home, '.claude'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true, env });
  const installed = run(['install']);
  assert.strictEqual(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /Installed the session-doctor skill for Claude Code/);
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'session-doctor', 'SKILL.md')));
  const removed = run(['uninstall']);
  assert.strictEqual(removed.status, 0, removed.stderr);
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'session-doctor')));
});
