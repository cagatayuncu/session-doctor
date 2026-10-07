'use strict';

const path = require('path');

const LIB = path.join(__dirname, '..', 'plugins', 'session-doctor', 'skills', 'session-doctor', 'scripts', 'lib');
const CLI = path.join(LIB, '..', 'session-doctor.js');
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const HOUR = 3600000;

function lib(name) {
  return require(path.join(LIB, name));
}

function proc(pid, ppid, name, cmd = '', ageHours = 1, mb = 10) {
  return { pid, ppid, name, cmd, created: NOW - ageHours * HOUR, mb };
}

module.exports = { LIB, CLI, NOW, HOUR, lib, proc };
