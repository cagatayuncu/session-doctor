'use strict';
// Plain-language view of a diagnosis: sessions grouped by project with idle tiers, what
// can be cleaned up and how much that frees. Pure; used by the text report and `status`.

const { sum } = require('./util');

const WORKING_MINUTES = 5;
const RECENT_MINUTES = 60;
const CANDIDATE_STATES = ['stale', 'hung', 'orphan-cli'];
const TIER_ORDER = { this: 0, working: 1, recent: 2, idle: 3, stale: 4, hung: 5, 'orphan-cli': 6, unknown: 7 };

// this | working | recent | idle | stale | hung | orphan-cli | unknown
function tierOf(session) {
  if (session.state === 'self') return 'this';
  if (['hung', 'orphan-cli', 'stale', 'unknown'].includes(session.state)) return session.state;
  const idle = session.idleMinutes;
  if (session.status === 'busy') return 'working';
  if (!session.status && idle != null && idle < WORKING_MINUTES) return 'working';
  if (idle != null && idle < RECENT_MINUTES) return 'recent';
  return 'idle';
}

function lastSegment(p) {
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
}

// { group, where }: worktree sessions are listed under their repository.
function projectOf(session) {
  const cwd = String(session.cwd || '');
  if (!cwd) return { group: session.agent === 'claude' ? '(folder unknown)' : `(${session.agent} sessions)`, where: '' };
  if (/scratch-workspaces/i.test(cwd)) return { group: '(no project folder)', where: '' };
  const worktree = cwd.match(/^(.*?)[\\/]\.(?:claude|cursor)[\\/]worktrees[\\/]([^\\/]+)/);
  if (worktree) return { group: lastSegment(worktree[1]), where: `worktree ${worktree[2]}` };
  return { group: lastSegment(cwd) || cwd, where: '' };
}

function totals(items) {
  return { count: items.length, procs: sum(items, 'procs'), mb: sum(items, 'mb'), pids: items.map((i) => i.pid) };
}

function bySessionOrder(a, b) {
  return (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || ((a.idleMinutes ?? Infinity) - (b.idleMinutes ?? Infinity));
}

function groupByProject(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project).push(s);
  }
  const freshest = (list) => Math.min(...list.map((s) => TIER_ORDER[s.tier] * 1e6 + (s.idleMinutes ?? 1e5)));
  return [...groups.entries()]
    .map(([name, list]) => ({ name, sessions: [...list].sort(bySessionOrder), mb: sum(list, 'mb') }))
    .sort((a, b) => freshest(a.sessions) - freshest(b.sessions));
}

function summarize(d) {
  const sessions = d.sessions.map((s) => {
    const { group, where } = projectOf(s);
    return { ...s, tier: tierOf(s), project: group, where };
  });
  const tiers = {};
  for (const s of sessions) tiers[s.tier] = (tiers[s.tier] || 0) + 1;
  const safe = [...d.orphans.filter((g) => g.category === 'orphan-agent'), ...d.stuckHooks];
  const orphanTasks = d.orphans.filter((g) => g.category === 'orphan-task');
  const candidates = Object.fromEntries(CANDIDATE_STATES.map((state) => [state, totals(sessions.filter((s) => s.state === state))]));
  const candidateSessions = sessions.filter((s) => CANDIDATE_STATES.includes(s.state));
  // A stuck hook inside a session that would be closed anyway is not counted twice.
  const insideSessions = new Set(candidateSessions.flatMap((s) => (s.members || []).map((m) => m.pid)));
  const reclaimable = [...[...safe, ...orphanTasks].filter((g) => !insideSessions.has(g.pid)), ...candidateSessions];
  return {
    sessions: { count: sessions.length, mb: sum(sessions, 'mb'), mcp: sessions.reduce((t, s) => t + ((s.children && s.children.mcp) || 0), 0) },
    tiers,
    groups: groupByProject(sessions),
    safe: totals(safe),
    orphanTasks: totals(orphanTasks),
    candidates,
    reclaim: totals(reclaimable),
  };
}

module.exports = { tierOf, projectOf, summarize };
