'use strict';
// Process tree with the two traps of real systems handled: Windows reuses PIDs (a
// "parent" created after its child is a different process), and Unix re-parents
// orphans to launchd/systemd (that parent means the launcher is gone).

const { normName } = require('./util');
const { INIT_NAMES } = require('./roles');

function buildIndex(processes) {
  const byPid = new Map();
  const kids = new Map();
  for (const proc of processes) {
    byPid.set(proc.pid, proc);
    if (!kids.has(proc.ppid)) kids.set(proc.ppid, []);
    kids.get(proc.ppid).push(proc);
  }
  return { byPid, kids };
}

function liveParent(proc, index) {
  if (proc.ppid === proc.pid) return null;
  const parent = index.byPid.get(proc.ppid);
  if (!parent) return null;
  if (parent.created != null && proc.created != null && parent.created > proc.created) return null;
  if (INIT_NAMES.has(normName(parent.name))) return null;
  return parent;
}

// Breadth-first, root first. Children listed in stopAt (other sessions) are not entered.
function subtree(root, index, stopAt = new Set()) {
  const result = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (seen.has(node.pid)) continue;
    seen.add(node.pid);
    result.push(node);
    for (const kid of index.kids.get(node.pid) || []) {
      if (stopAt.has(kid.pid)) continue;
      if (liveParent(kid, index) === node) queue.push(kid);
    }
  }
  return result;
}

// This process, its ancestors, and the whole tree of the agent session running it.
function protectedSet(index, roles, selfPid, cliPids) {
  const pids = new Set();
  let selfCli = null;
  let node = index.byPid.get(selfPid);
  while (node && !pids.has(node.pid)) {
    pids.add(node.pid);
    if (!selfCli && roles.get(node.pid) === 'cli') selfCli = node;
    node = liveParent(node, index);
  }
  if (selfCli) {
    const others = new Set([...cliPids].filter((pid) => pid !== selfCli.pid));
    for (const member of subtree(selfCli, index, others)) pids.add(member.pid);
  }
  return { pids, selfCliPid: selfCli ? selfCli.pid : 0 };
}

module.exports = { buildIndex, liveParent, subtree, protectedSet };
