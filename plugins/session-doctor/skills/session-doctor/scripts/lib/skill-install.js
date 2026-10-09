'use strict';
// `install` / `uninstall`: copy this skill folder into an agent's skills directory, so
// `npx github:cagatayuncu/session-doctor install` is all a user needs. Only a folder that
// is recognisably this skill is ever replaced or removed; links (development installs)
// and anyone else's folders are left alone.

const fs = require('fs');
const path = require('path');

const SKILL_NAME = 'session-doctor';
const NAME_LINE = /^name:\s*["']?session-doctor["']?\s*$/m;
const IS_WIN = process.platform === 'win32';

// Cursor also reads ~/.claude/skills, so one Claude Code install serves both.
function skillTargets({ claudeHome, cursorHome, home }) {
  return {
    claude: path.join(claudeHome, 'skills', SKILL_NAME),
    cursor: path.join(cursorHome, 'skills', SKILL_NAME),
    agents: path.join(home, '.agents', 'skills', SKILL_NAME),
  };
}

function autoAgent({ claudeHome, cursorHome }) {
  if (fs.existsSync(claudeHome)) return 'claude';
  if (fs.existsSync(cursorHome)) return 'cursor';
  return 'agents';
}

// missing | link | ours | foreign
function inspectTarget(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing';
    throw err;
  }
  if (stat.isSymbolicLink()) return 'link';
  if (!stat.isDirectory()) return 'foreign';
  try {
    return NAME_LINE.test(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')) ? 'ours' : 'foreign';
  } catch {
    return 'foreign';
  }
}

function samePath(a, b) {
  const real = (p) => {
    const resolved = fs.existsSync(p) ? fs.realpathSync.native(p) : path.resolve(p);
    return IS_WIN ? resolved.toLowerCase() : resolved;
  };
  return real(a) === real(b);
}

function refuse(state, target) {
  if (state === 'link') return new Error(`${target} is a link (a development install?); remove it yourself if you want a copied install`);
  return new Error(`${target} exists and is not session-doctor; not touching it`);
}

// installed | updated | already
function installSkill(skillDir, target) {
  const state = inspectTarget(target);
  if (state === 'link' || state === 'foreign') throw refuse(state, target);
  if (state === 'ours' && samePath(skillDir, target)) return 'already';
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) throw new Error(`no SKILL.md in ${skillDir}`);
  const staging = `${target}.new-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(skillDir, staging, { recursive: true });
  if (state === 'ours') fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  return state === 'ours' ? 'updated' : 'installed';
}

// removed | absent
function uninstallSkill(target) {
  const state = inspectTarget(target);
  if (state === 'missing') return 'absent';
  if (state !== 'ours') throw refuse(state, target);
  fs.rmSync(target, { recursive: true, force: true });
  return 'removed';
}

module.exports = { SKILL_NAME, skillTargets, autoAgent, inspectTarget, installSkill, uninstallSkill };
