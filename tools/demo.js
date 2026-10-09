#!/usr/bin/env node
'use strict';
// Creates two harmless fake leaks so you can watch session-doctor find and stop them:
// an idle node process that looks like an MCP server and one that looks like a hook.
// Each is started by a launcher that exits at once, which leaves it orphaned, exactly
// what a crashed or timed-out agent leaves behind. Nothing else on the machine is touched.

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const CLI = path.join(__dirname, '..', 'plugins', 'session-doctor', 'skills', 'session-doctor', 'scripts', 'session-doctor.js');
const IDLE = 'setInterval(() => {}, 1 << 30)';
const FAKES = [
  { what: 'fake MCP server', args: ['session-doctor-demo-mcp'] },
  { what: 'fake hook', args: [path.join(os.homedir(), '.session-doctor-demo', 'hooks', 'demo-hook.js')] },
];
const LAUNCHER = [
  "const { spawn } = require('child_process');",
  `const child = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}, ...JSON.parse(process.argv[1])], { detached: true, stdio: 'ignore', windowsHide: true });`,
  'child.unref();',
  'process.stdout.write(String(child.pid));',
].join(' ');

function launchOrphan(args) {
  const result = spawnSync(process.execPath, ['-e', LAUNCHER, JSON.stringify(args)], { encoding: 'utf8', windowsHide: true });
  const pid = Number(String(result.stdout).trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`could not start the demo process: ${result.stderr}`);
  return pid;
}

const started = FAKES.map((fake) => ({ ...fake, pid: launchOrphan(fake.args) }));
const pids = started.map((s) => s.pid).join(',');
const node = `node "${CLI}"`;
const lines = [
  'Started two fake leaks (idle node processes whose launcher has exited):',
  ...started.map((s) => `  pid ${s.pid}  ${s.what}`),
  '',
  '1) See them in the report (section "Leaked processes"):',
  `   ${node} diagnose --quick`,
  '2) Dry run, which shows what would be stopped and stops nothing:',
  `   ${node} cleanup --category orphan-agent,orphan-task --only ${pids}`,
  '3) Stop them:',
  `   ${node} cleanup --category orphan-agent,orphan-task --only ${pids} --apply`,
  '',
  'On Windows they are "safe" leaks. On macOS/Linux launchd/systemd adopts orphans, so they',
  'show as "your choice" instead: a process adopted that way might be a service run on purpose.',
];
process.stdout.write(`${lines.join('\n')}\n`);
