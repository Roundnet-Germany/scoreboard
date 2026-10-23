import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMatch, setModeToFormat, serveInfo, STALE_AFTER_MS, FINISHED_VISIBLE_MS } from '../js/matchStatus.js';

// Runs without the emulator: npm run test:unit
const NOW = 1_800_000_000_000;
const sets = (...pairs) => Object.fromEntries(pairs.map(([a, b], i) => [`set_${i + 1}`, { team_a_score: a, team_b_score: b }]));
const match = ({ score = {}, active_set = 1, set_mode = 'BO3', updatedAgo = 60_000, ...rest } = {}) => ({
  score, active_set, game_settings: { win_points: 15, hardcap: 21, set_mode }, updated_at: NOW - updatedAgo, ...rest,
});

describe('status', () => {
  test('points and a recent update -> live', () => {
    assert.equal(summarizeMatch(match({ score: sets([5, 3]) }), NOW).status, 'live');
  });

  test('recent update without points -> ready (game loaded, not started)', () => {
    assert.equal(summarizeMatch(match(), NOW).status, 'ready');
  });

  test('no change for the stale window -> idle, even mid-set', () => {
    assert.equal(summarizeMatch(match({ score: sets([5, 3]), updatedAgo: STALE_AFTER_MS }), NOW).status, 'idle');
  });

  test('no updated_at at all -> idle', () => {
    assert.equal(summarizeMatch({ score: sets([5, 3]) }, NOW).status, 'idle');
    assert.equal(summarizeMatch(null, NOW).status, 'idle');
  });

  test('BO3 decided 2:0 -> finished, with winner', () => {
    const s = summarizeMatch(match({ score: sets([15, 10], [15, 12]), active_set: 2 }), NOW);
    assert.equal(s.status, 'finished');
    assert.equal(s.winner, 'a');
    assert.deepEqual(s.setsWon, { a: 2, b: 0 });
  });

  test('BO3 at 1:1 is still running', () => {
    const s = summarizeMatch(match({ score: sets([15, 10], [8, 15], [2, 1]), active_set: 3 }), NOW);
    assert.equal(s.status, 'live');
    assert.equal(s.sets.length, 3);
  });

  test('a decided match stays finished longer than a running one stays live', () => {
    const decided = { score: sets([15, 10], [15, 12]), active_set: 2 };
    assert.equal(summarizeMatch(match({ ...decided, updatedAgo: STALE_AFTER_MS + 60_000 }), NOW).status, 'finished');
    assert.equal(summarizeMatch(match({ ...decided, updatedAgo: FINISHED_VISIBLE_MS }), NOW).status, 'idle');
  });

  test('2-set mode ends 1:1 without a winner', () => {
    const s = summarizeMatch(match({ score: sets([15, 10], [8, 15]), active_set: 2, set_mode: '2 Sets' }), NOW);
    assert.equal(s.status, 'finished');
    assert.equal(s.winner, null);
  });

  test('numeric strings are read as scores', () => {
    const s = summarizeMatch(match({ score: { set_1: { team_a_score: '15', team_b_score: '3' } }, set_mode: '1 Set' }), NOW);
    assert.equal(s.status, 'finished');
  });
});

describe('set and match point', () => {
  test('14:12 in set 1 of BO3 is set point', () => {
    assert.deepEqual(summarizeMatch(match({ score: sets([14, 12]) }), NOW).pointFor, [{ team: 'a', kind: 'set' }]);
  });

  test('14:12 after winning set 1 is match point', () => {
    assert.deepEqual(summarizeMatch(match({ score: sets([15, 9], [14, 12]), active_set: 2 }), NOW).pointFor, [{ team: 'a', kind: 'match' }]);
  });

  test('20:20 with hardcap 21 is match/set point for both', () => {
    const s = summarizeMatch(match({ score: sets([20, 20]), set_mode: '1 Set' }), NOW);
    assert.deepEqual(s.pointFor, [{ team: 'a', kind: 'match' }, { team: 'b', kind: 'match' }]);
  });

  test('14:14 is nobody\'s point', () => {
    assert.equal(summarizeMatch(match({ score: sets([14, 14]) }), NOW).pointFor, null);
  });
});

describe('timer', () => {
  test('a running timeout reports its remaining time', () => {
    const s = summarizeMatch(match({ score: sets([5, 3]), timer: { type: 'timeout', started_at: NOW - 20_000 } }), NOW);
    assert.equal(s.timer.label, 'Timeout');
    assert.equal(s.timer.remainingMs, 40_000);
  });

  test('an expired timer is gone', () => {
    assert.equal(summarizeMatch(match({ timer: { type: 'timeout', started_at: NOW - 61_000 } }), NOW).timer, null);
  });
});

test('setModeToFormat', () => {
  assert.equal(setModeToFormat('1 Set'), 0);
  assert.equal(setModeToFormat('2 Sets'), 1);
  assert.equal(setModeToFormat('Best of 3'), 2);
  assert.equal(setModeToFormat(''), 2);
});

describe('serve', () => {
  const settings = { winPoints: 15, hardcap: 21, minMargin: 2 };

  test('first serve of a set is a single serve of the starting team', () => {
    assert.deepEqual(serveInfo(0, 0, 'a', settings), { team: 'a', serveNumber: 1, single: true });
    assert.deepEqual(serveInfo(0, 0, 'd', settings), { team: 'b', serveNumber: 1, single: true });
  });

  test('then two serves each, alternating', () => {
    assert.deepEqual(serveInfo(1, 0, 'a', settings), { team: 'b', serveNumber: 1, single: false });
    assert.deepEqual(serveInfo(1, 1, 'a', settings), { team: 'b', serveNumber: 2, single: false });
    assert.deepEqual(serveInfo(2, 1, 'a', settings), { team: 'a', serveNumber: 1, single: false });
  });

  test('overtime: serve changes every point', () => {
    assert.deepEqual(serveInfo(14, 15, 'a', settings), { team: 'b', serveNumber: 1, single: true });
    assert.deepEqual(serveInfo(15, 15, 'a', settings), { team: 'a', serveNumber: 1, single: true });
  });

  test('no starting server -> unknown', () => {
    assert.equal(serveInfo(3, 2, '', settings), null);
  });

  test('summary has no serve once the match is decided', () => {
    const score = { set_1: { team_a_score: 15, team_b_score: 3, starting_server: 'a' } };
    assert.equal(summarizeMatch(match({ score, set_mode: '1 Set' }), NOW).serve, null);
    const running = { set_1: { team_a_score: 1, team_b_score: 0, starting_server: 'a' } };
    assert.equal(summarizeMatch(match({ score: running }), NOW).serve.team, 'b');
  });
});
