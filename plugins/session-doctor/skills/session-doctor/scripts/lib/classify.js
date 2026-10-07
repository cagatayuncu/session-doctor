'use strict';
// Turns a process snapshot into the report categories: agent sessions (active, stale,
// hung, orphan-cli, unknown), orphaned agent processes, stuck hooks, desktop terminal
// shells and per-IDE MCP counts. Pure: everything comes in through the context.

const { normName, shortCommand, sum, ageMinutes } = require('./util');
const { INIT_NAMES, hookSignature, hookMatch, processRole, cliAgent, ideLabel, isHeadless, isNeverStop, isNonInteractiveShell } = require('./roles');
const { buildIndex, liveParent, subtree, protectedSet } = require('./tree');
const { sessionActivity, sessionState } = require('./sessions');

const SAFE_SUBTREE_ROLES = new Set(['shell', 'claude-shell', 'hook', 'mcp', 'plugin']);
const UNSTOPPABLE_ROLES = new Set(['desktop-app', 'ide-app', 'init']);
const LAUNCHER_ROLES = new Set(['cli', 'desktop-app', 'ide-app']);
const MAX_HOOK_CHAIN = 8;
const DEFAULTS = { staleHours: 12, hungMinutes: 30, hookMaxMinutes: 10 };

function buildContext(input) {
  const options = { ...DEFAULTS, ...input };
  const processes = options.processes || [];
  const index = buildIndex(processes);
  const signatures = (options.hookConfig || []).map((h) => hookSignature(h.command, h.pluginRoot, h.timeout)).filter(Boolean);
  const roles = new Map();
  const hookInfo = new Map();
  const cliPids = new Set();
  for (const proc of processes) {
    const role = processRole(proc, signatures);
    roles.set(proc.pid, role);
    if (role === 'cli') cliPids.add(proc.pid);
    if (role === 'hook') hookInfo.set(proc.pid, hookMatch(proc.cmd, signatures));
  }
  const prot = protectedSet(index, roles, options.selfPid || 0, cliPids);
  return {
    ...options,
    index,
    roles,
    hookInfo,
    cliPids,
    protected: prot.pids,
    selfCliPid: prot.selfCliPid,
    registry: options.registry || new Map(),
    transcripts: options.transcripts || new Map(),
    cursorChats: options.cursorChats || new Map(),
    ports: options.ports || new Map(),
    portsKnown: options.portsKnown !== false,
    now: options.now || Date.now(),
  };
}

// Only the root decides: an unrelated orphan (explorer.exe's parent is always gone) must
// never be claimed because something agent-like runs somewhere below it.
// A hook/MCP/plugin process that listens on a port, that launchd/systemd adopted, or that
// matches a hook only loosely may be something run on purpose: it needs a confirmation.
function orphanCategory(rootRole, memberRoles, flags = {}) {
  const { servesPorts = false, reparented = false, looseHook = false, portsKnown = true } = flags;
  if (rootRole === 'hook') return servesPorts || reparented || looseHook ? 'orphan-task' : 'orphan-agent';
  if (['mcp', 'plugin'].includes(rootRole)) return servesPorts || reparented || !portsKnown ? 'orphan-task' : 'orphan-agent';
  if (rootRole === 'claude-shell') {
    return memberRoles.slice(1).every((r) => SAFE_SUBTREE_ROLES.has(r)) ? 'orphan-agent' : 'orphan-task';
  }
  if (rootRole === 'dev-server') return 'orphan-task';
  return null;
}

function isUnstoppable(member, ctx) {
  return ctx.protected.has(member.pid) || UNSTOPPABLE_ROLES.has(ctx.roles.get(member.pid)) || isNeverStop(member.name);
}

// Last line of defence for orphan and hook groups: nothing from an app, this session or the OS shell.
function isStoppable(members, ctx) {
  return members.every((m) => !isUnstoppable(m, ctx));
}

// Was this hook process started by an agent? Agents run hooks through a shell in command
// mode; an interactive shell or an agent's tool shell in between means a user or a tool
// started it, and a matching command line is then a coincidence.
function agentLaunched(proc, ctx) {
  let node = liveParent(proc, ctx.index);
  for (let depth = 0; node && depth < MAX_HOOK_CHAIN; depth += 1) {
    const role = ctx.roles.get(node.pid);
    if (LAUNCHER_ROLES.has(role)) return true;
    if (role !== 'hook' && !(role === 'shell' && isNonInteractiveShell(node.cmd))) return false;
    node = liveParent(node, ctx.index);
  }
  return false;
}

function portsOf(members, ctx) {
  const ports = new Set();
  for (const m of members) for (const port of ctx.ports.get(m.pid) || []) ports.add(port);
  return [...ports].sort((a, b) => a - b);
}

function roleCounts(members, ctx) {
  const counts = {};
  for (const m of members.slice(1)) {
    const role = ctx.roles.get(m.pid);
    counts[role] = (counts[role] || 0) + 1;
  }
  return counts;
}

// keep: never stopped even when its group is (an app or OS process found inside a session tree).
function memberList(members, ctx) {
  return members.map((m) => ({ pid: m.pid, created: m.created, keep: isUnstoppable(m, ctx) }));
}

function makeGroup(category, root, members, ctx) {
  const workload = members
    .filter((m) => !['shell', 'claude-shell'].includes(ctx.roles.get(m.pid)))
    .slice(0, 2)
    .map((m) => shortCommand(m.cmd, 70));
  return {
    category,
    pid: root.pid,
    name: root.name,
    role: ctx.roles.get(root.pid),
    ageHours: Math.round(ageMinutes(root, ctx.now) / 6) / 10,
    procs: members.length,
    mb: sum(members, 'mb'),
    ports: portsOf(members, ctx),
    command: shortCommand(root.cmd),
    workload: workload.join(' ; '),
    members: memberList(members, ctx),
  };
}

function orphanGroups(ctx) {
  const groups = [];
  for (const proc of ctx.index.byPid.values()) {
    if (proc.pid <= 4 || ctx.protected.has(proc.pid) || liveParent(proc, ctx.index)) continue;
    const role = ctx.roles.get(proc.pid);
    if (role === 'cli' || UNSTOPPABLE_ROLES.has(role)) continue;
    const members = subtree(proc, ctx.index, ctx.cliPids);
    const info = ctx.hookInfo.get(proc.pid);
    const flags = {
      servesPorts: portsOf(members, ctx).length > 0,
      reparented: isAdopted(proc, ctx),
      looseHook: Boolean(info && info.strength !== 'strong'),
      portsKnown: ctx.portsKnown,
    };
    const category = orphanCategory(role, members.map((m) => ctx.roles.get(m.pid)), flags);
    if (category && isStoppable(members, ctx)) groups.push(makeGroup(category, proc, members, ctx));
  }
  return groups;
}

// A hook has outlived both the limit and its own configured timeout.
function hookLimitMinutes(proc, ctx) {
  const info = ctx.hookInfo.get(proc.pid);
  const configured = info && info.timeoutSec ? info.timeoutSec / 60 + 1 : 0;
  return Math.max(ctx.hookMaxMinutes, configured);
}

function stuckHookGroups(ctx) {
  const groups = [];
  for (const proc of ctx.index.byPid.values()) {
    if (ctx.roles.get(proc.pid) !== 'hook' || ctx.protected.has(proc.pid)) continue;
    const parent = liveParent(proc, ctx.index);
    if (!parent || ctx.roles.get(parent.pid) === 'hook') continue; // orphans elsewhere; topmost hook only
    if (!agentLaunched(proc, ctx)) continue;
    if (ageMinutes(proc, ctx.now) < hookLimitMinutes(proc, ctx)) continue;
    const members = subtree(proc, ctx.index, ctx.cliPids);
    if (isStoppable(members, ctx)) groups.push(makeGroup('stuck-hook', proc, members, ctx));
  }
  return groups;
}

// Parent is launchd/systemd/init: the original launcher is gone and init adopted it.
function isAdopted(proc, ctx) {
  const parent = ctx.index.byPid.get(proc.ppid);
  return Boolean(parent && parent.pid !== proc.pid && INIT_NAMES.has(normName(parent.name)));
}

function sessionRecord(proc, ctx) {
  const agent = cliAgent(normName(proc.name), proc.cmd || '');
  const activity = sessionActivity(agent, proc, ctx);
  const age = ageMinutes(proc, ctx.now);
  const state = sessionState({
    isSelf: proc.pid === ctx.selfCliPid,
    parentAlive: Boolean(liveParent(proc, ctx.index)),
    adopted: isAdopted(proc, ctx),
    status: activity.status,
    lastActivity: activity.lastActivity,
    now: ctx.now,
    staleHours: ctx.staleHours,
    hungMinutes: ctx.hungMinutes,
    headless: isHeadless(agent, proc.cmd),
    ageMinutes: age,
  });
  const others = new Set([...ctx.cliPids].filter((pid) => pid !== proc.pid));
  const members = subtree(proc, ctx.index, others);
  return {
    ...makeGroup(state, proc, members, ctx),
    state,
    agent,
    sessionId: activity.sessionId,
    hostSessionId: activity.hostSessionId,
    status: activity.status,
    title: activity.name,
    cwd: activity.cwd,
    idleMinutes: activity.lastActivity == null ? null : Math.round((ctx.now - activity.lastActivity) / 60000),
    lastTool: activity.lastTool,
    subagent: activity.subagent,
    children: roleCounts(members, ctx),
  };
}

function sessionInventory(ctx) {
  return [...ctx.cliPids].map((pid) => sessionRecord(ctx.index.byPid.get(pid), ctx));
}

function desktopTerminals(ctx) {
  const shells = [];
  for (const proc of ctx.index.byPid.values()) {
    if (ctx.roles.get(proc.pid) !== 'shell') continue;
    const parent = liveParent(proc, ctx.index);
    if (parent && ctx.roles.get(parent.pid) === 'desktop-app') {
      shells.push({ pid: proc.pid, name: proc.name, ageHours: Math.round(ageMinutes(proc, ctx.now) / 6) / 10, mb: proc.mb });
    }
  }
  return shells;
}

// MCP servers and agent CLIs running under each IDE (Cursor, VS Code, ...): one copy per window.
function ideHosts(ctx) {
  const hosts = new Map();
  for (const proc of ctx.index.byPid.values()) {
    if (ctx.roles.get(proc.pid) !== 'ide-app') continue;
    const parent = liveParent(proc, ctx.index);
    if (parent && ctx.roles.get(parent.pid) === 'ide-app') continue;
    const label = ideLabel(normName(proc.name), proc.cmd || '');
    const host = hosts.get(label) || { label, roots: 0, mcp: 0, mcpMb: 0, clis: 0, hooks: 0 };
    host.roots += 1;
    for (const m of subtree(proc, ctx.index)) {
      const role = ctx.roles.get(m.pid);
      if (role === 'mcp') { host.mcp += 1; host.mcpMb += m.mb; }
      if (role === 'cli') host.clis += 1;
      if (role === 'hook') host.hooks += 1;
    }
    hosts.set(label, host);
  }
  return [...hosts.values()];
}

function classify(ctx) {
  return {
    selfCliPid: ctx.selfCliPid,
    sessions: sessionInventory(ctx),
    orphans: orphanGroups(ctx),
    stuckHooks: stuckHookGroups(ctx),
    terminals: desktopTerminals(ctx),
    ideHosts: ideHosts(ctx),
  };
}

const CLEANUP_CATEGORIES = ['orphan-agent', 'stuck-hook', 'orphan-task', 'orphan-cli', 'stale', 'hung', 'unknown'];

function selectTargets(result, categories, only = [], protectedPids = new Set()) {
  const pool = [...result.orphans, ...result.stuckHooks, ...result.sessions];
  return pool.filter((t) => categories.includes(t.category)
    && (only.length === 0 || only.includes(t.pid))
    // 'unknown' sessions have no activity signal, so they are only taken when named explicitly.
    && (t.category !== 'unknown' || only.length > 0)
    && !['self', 'active'].includes(t.category)
    && !protectedPids.has(t.pid));
}

module.exports = {
  DEFAULTS,
  CLEANUP_CATEGORIES,
  buildContext,
  orphanCategory,
  orphanGroups,
  stuckHookGroups,
  sessionInventory,
  desktopTerminals,
  ideHosts,
  classify,
  selectTargets,
};
