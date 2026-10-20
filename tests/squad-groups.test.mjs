import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { groupSquadGames, isFlipped, normalizeTeamName, squadScore } from '../js/squadGroups.js';
import { summarizeMatch } from '../js/matchStatus.js';

// Runs without the emulator: npm run test:unit
const NOW = 1_800_000_000_000;
const sets = (...pairs) => Object.fromEntries(pairs.map(([a, b], i) => [`set_${i + 1}`, { team_a_score: a, team_b_score: b }]));

/** A court view as overview.js builds it - only what the grouping reads. */
const court = (channel, { mainGameId = null, a = 'Squad A', b = 'Squad B', score = {}, activeSet = 1, courtNumber = channel } = {}) => {
  const summary = summarizeMatch({
    score, active_set: activeSet, updated_at: NOW - 60_000,
    game_settings: { win_points: 15, hardcap: 21, set_mode: 'Best of 3' },
  }, NOW);
  return { channel, courtNumber, mainGameId, status: summary.status, winner: summary.winner, teams: { a: { name: a }, b: { name: b } } };
};

describe('team names', () => {
  test('case, spacing and accents do not matter', () => {
    assert.equal(normalizeTeamName('  Roundnet  Café '), 'roundnet cafe');
  });

  test('same names -> same side', () => {
    assert.equal(isFlipped({ a: 'Squad A', b: 'Squad B' }, { a: 'squad a', b: 'Squad B' }), false);
  });

  test('both names swapped -> flipped', () => {
    assert.equal(isFlipped({ a: 'Squad A', b: 'Squad B' }, { a: 'Squad B', b: 'Squad A' }), true);
  });

  test('unclear names fall back to the same side (what the Playerzone sends)', () => {
    assert.equal(isFlipped({ a: 'Squad A', b: 'Squad B' }, { a: 'Squad B', b: 'Someone' }), false);
    assert.equal(isFlipped({ a: 'Squad A', b: 'Squad B' }, { a: 'Team A', b: 'Team B' }), false);
    assert.equal(isFlipped({ a: 'Same', b: 'Same' }, { a: 'Same', b: 'Same' }), false);
  });
});

describe('grouping', () => {
  test('courts with the same main_game_id become one squad entry', () => {
    const entries = groupSquadGames([court(1, { mainGameId: 7 }), court(2), court(3, { mainGameId: 7 }), court(4, { mainGameId: 7 })]);
    assert.deepEqual(entries.map((e) => e.key), ['squad-7', 'court-2']);
    assert.deepEqual(entries[0].members.map((m) => m.view.channel), [1, 3, 4]);
  });

  test('no main_game_id (or 0) never groups', () => {
    const entries = groupSquadGames([court(1), court(2), court(3, { mainGameId: 0 })]);
    assert.deepEqual(entries.map((e) => e.type), ['court', 'court', 'court']);
  });

  test('a lone subgame stays a normal court', () => {
    const entries = groupSquadGames([court(1, { mainGameId: 7 }), court(2, { mainGameId: 8 })]);
    assert.deepEqual(entries.map((e) => e.key), ['court-1', 'court-2']);
  });

  test('two squad games stay apart', () => {
    const entries = groupSquadGames([court(1, { mainGameId: 7 }), court(2, { mainGameId: 8 }), court(3, { mainGameId: 7 }), court(4, { mainGameId: 8 })]);
    assert.deepEqual(entries.map((e) => e.key), ['squad-7', 'squad-8']);
  });

  test('subgames are ordered by court, the squad takes the most active status', () => {
    const finished = court(5, { mainGameId: 7, score: sets([15, 3], [15, 4]), activeSet: 2, courtNumber: 1 });
    const live = court(2, { mainGameId: 7, score: sets([4, 2]), courtNumber: 3 });
    const [entry] = groupSquadGames([finished, live]);
    assert.deepEqual(entry.members.map((m) => m.view.courtNumber), [1, 3]);
    assert.equal(entry.status, 'live');
  });
});

describe('squad score', () => {
  test('counts decided subgames per squad, running ones do not count', () => {
    const [entry] = groupSquadGames([
      court(1, { mainGameId: 7, score: sets([15, 10], [15, 12]), activeSet: 2 }), // A
      court(2, { mainGameId: 7, score: sets([8, 15], [15, 13], [9, 15]), activeSet: 3 }), // B
      court(3, { mainGameId: 7, score: sets([15, 5], [15, 7]), activeSet: 2 }), // A
      court(4, { mainGameId: 7, score: sets([15, 5], [3, 1]), activeSet: 2 }), // running
    ]);
    assert.deepEqual(entry.score, { a: 2, b: 1 });
    assert.equal(entry.decided, 3);
  });

  test('a subgame with swapped names counts for the right squad', () => {
    const [entry] = groupSquadGames([
      court(1, { mainGameId: 7, score: sets([15, 10], [15, 12]), activeSet: 2 }),
      // Squad B entered as team A here and won as team A
      court(2, { mainGameId: 7, a: 'Squad B', b: 'Squad A', score: sets([15, 10], [15, 12]), activeSet: 2 }),
    ]);
    assert.deepEqual(entry.members.map((m) => m.flipped), [false, true]);
    assert.deepEqual(entry.score, { a: 1, b: 1 });
  });

  test('a 1:1 in 2-set mode has no winner and counts for nobody', () => {
    assert.deepEqual(squadScore([{ view: { winner: null }, flipped: false }]), { a: 0, b: 0 });
  });
});
