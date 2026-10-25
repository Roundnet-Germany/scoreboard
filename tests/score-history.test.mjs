import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { historyScore, reconcileScore, recordSquadScore, cleanScoreEvents } from '../js/scoreHistory.js';

// Runs without the emulator: npm run test:unit
const pt = (team, score, set = 1) => ({ type: 'score', team, score, set });
const scores = (list, set = 1) => list.filter((e) => e.type === 'score' && e.set === set).map((e) => `${e.team}${e.score}`);

/** Applies a sequence of [team, score] entries like the input panel would. */
function play(steps, list = [{ type: 'reset' }]) {
  for (const [team, score, set = 1] of steps) reconcileScore(list, { team, set, score });
  return list;
}

describe('reconcileScore', () => {
  test('+1 points append one event each', () => {
    assert.deepEqual(scores(play([['a', 1], ['b', 1], ['a', 2]])), ['a1', 'b1', 'a2']);
  });

  test('-1 removes the newest point of that team, even if the other team scored after it', () => {
    assert.deepEqual(scores(play([['a', 1], ['a', 2], ['b', 1], ['a', 1]])), ['a1', 'b1']);
  });

  test('correcting several points at once removes all of them', () => {
    const list = play([['a', 1], ['a', 2], ['b', 1], ['a', 3], ['a', 4], ['a', 2]]);
    assert.deepEqual(scores(list), ['a1', 'a2', 'b1']);
    assert.equal(historyScore(list, 'a', 1), 2);
  });

  test('a typed jump fills in every point, so the point count stays right', () => {
    assert.deepEqual(scores(play([['b', 1], ['a', 3]])), ['b1', 'a1', 'a2', 'a3']);
  });

  test('wrong team: -1 on one, +1 on the other', () => {
    assert.deepEqual(scores(play([['a', 1], ['a', 2], ['a', 1], ['b', 1]])), ['a1', 'b1']);
  });

  test('typo and back: 15 -> 150 -> 15 ends where it started', () => {
    const list = play([['a', 15]]);
    const before = scores(list);
    play([['a', 150], ['a', 15]], list);
    assert.deepEqual(scores(list), before);
  });

  test('idempotent: the same score twice (transaction re-run, second device) adds nothing', () => {
    assert.deepEqual(scores(play([['a', 1], ['a', 1], ['b', 1], ['b', 1]])), ['a1', 'b1']);
  });

  test('back to 0 clears the team in that set only', () => {
    const list = play([['a', 1], ['b', 1], ['a', 1, 2], ['a', 0]]);
    assert.deepEqual(scores(list), ['b1']);
    assert.deepEqual(scores(list, 2), ['a1']);
  });

  test('sets are independent, events before the last reset are left alone', () => {
    const list = [pt('a', 1), pt('a', 2), { type: 'reset' }];
    play([['a', 1]], list);
    assert.equal(list.length, 4);
    assert.deepEqual(list.slice(0, 2), [pt('a', 1), pt('a', 2)]);
    assert.equal(historyScore(list, 'a', 1), 1);
  });

  test('repairs a broken history: a leftover higher event is dropped', () => {
    const list = [{ type: 'reset' }, pt('a', 1), pt('a', 2), pt('a', 5)];
    reconcileScore(list, { team: 'a', set: 1, score: 3 });
    assert.deepEqual(scores(list), ['a1', 'a2', 'a3']);
  });

  test('set numbers stored as strings still match', () => {
    const list = [{ type: 'reset' }, pt('a', 1, '1')];
    reconcileScore(list, { team: 'a', set: '1', score: 1 });
    assert.equal(list.length, 2);
  });

  test('a huge typo fills at most 60 points', () => {
    assert.equal(scores(play([['a', 999]])).length, 60);
  });

  test('ignores calls without team or set', () => {
    const list = play([['a', 1]]);
    reconcileScore(list, { team: null, set: 1, score: 3 });
    reconcileScore(list, { team: 'a', set: null, score: 3 });
    assert.deepEqual(scores(list), ['a1']);
  });
});

describe('recordSquadScore', () => {
  test('records changes only', () => {
    const list = [{ type: 'reset' }];
    recordSquadScore(list, { team: 'a', score: 1 });
    recordSquadScore(list, { team: 'a', score: 1 });
    recordSquadScore(list, { team: 'a', score: 2 });
    assert.deepEqual(list.slice(1).map((e) => e.score), [1, 2]);
  });
});

describe('cleanScoreEvents', () => {
  test('keeps a consistent history as is', () => {
    const events = [pt('a', 1), pt('b', 1), pt('a', 2)];
    assert.deepEqual(cleanScoreEvents(events, { a: 2, b: 1 }), events);
  });

  test('drops duplicates, steps back and events above the actual score', () => {
    const events = [pt('a', 1), pt('a', 1), pt('b', 1), pt('a', 2), pt('a', 1), pt('a', 3), pt('b', 2)];
    assert.deepEqual(scores(cleanScoreEvents(events, { a: 2, b: 1 })), ['a1', 'b1', 'a2']);
  });

  test('no limit for a team whose score is unknown (NaN)', () => {
    assert.equal(cleanScoreEvents([pt('a', 1), pt('a', 2)], { a: NaN, b: 0 }).length, 2);
  });

  test('drops events without a valid team', () => {
    assert.equal(cleanScoreEvents([pt(null, 0), pt('x', 1), pt('A', 1)], { a: 1, b: 0 }).length, 1);
  });
});
