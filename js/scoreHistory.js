// Score events of match-<channel>/event_history - pure functions without DOM
// or Firebase, so they run the same on the local list and inside the
// transaction in changeEventHistory() (main.js), and can be tested with node.
//
// Invariant kept for every team and set (after the last reset): its score
// events count up by one - 1, 2, 3, ... - and the newest one is the team's
// current score. A score change therefore isn't recorded as "add/remove an
// event" but as "make the history reach this score": idempotent, so a
// transaction re-run, a second device writing the same score, or an
// operator correcting a typo all end in the same consistent history.

/** Upper bound for points filled in at once (a typo like 150 instead of 15). */
const MAX_FILL = 60;

function lastResetIndex(list) {
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.type === 'reset') return i;
    }
    return -1;
}

const isScoreEventOf = (event, team, set) =>
    event?.type === 'score' && event.team === team && Number(event.set) === Number(set);

/** Newest score of a team in a set according to the history (0 without events). */
export function historyScore(list, team, set) {
    const start = lastResetIndex(list) + 1;
    for (let i = list.length - 1; i >= start; i--) {
        if (isScoreEventOf(list[i], team, set)) return Number(list[i].score) || 0;
    }
    return 0;
}

/**
 * Brings the history (in place) to `score` for a team in a set:
 * - lower: removes every event of that team and set above it - a correction
 *   of several points at once included, not just the newest one
 * - higher: appends one event per missing point, so the point count (serve
 *   order, statistics) stays right even for a typed jump like 10 -> 15
 * - equal: nothing
 */
export function reconcileScore(list, { team, set, score }) {
    if (!team || !Number(set)) return;
    const target = Math.max(0, Math.floor(Number(score) || 0));
    const start = lastResetIndex(list) + 1;
    for (let i = list.length - 1; i >= start; i--) {
        if (isScoreEventOf(list[i], team, set) && Number(list[i].score) > target) list.splice(i, 1);
    }
    const from = historyScore(list, team, set);
    for (let points = Math.max(from + 1, target - MAX_FILL + 1); points <= target; points++) {
        list.push({ type: 'score', team, score: points, set: Number(set) });
    }
}

/** Squad (liga) score: just the newest value per team, no point-by-point history. */
export function recordSquadScore(list, { team, score }) {
    if (!team) return;
    const value = Math.max(0, Math.floor(Number(score) || 0));
    const start = lastResetIndex(list) + 1;
    for (let i = list.length - 1; i >= start; i--) {
        const event = list[i];
        if (event?.type === 'squad_score' && event.team === team) {
            if (Number(event.score) === value) return;
            break;
        }
    }
    list.push({ type: 'squad_score', team, score: value, set: 'squad' });
}

/**
 * Score events of one set as the displays should read them, also from a
 * history that broke the invariant (old data, a board writing scores without
 * events): per team only strictly rising scores and none above the team's
 * actual score in that set.
 * @param {Array} events - score events of one set, in order
 * @param {{a: number, b: number}} finalScores - the set's current scores
 */
export function cleanScoreEvents(events, finalScores) {
    const last = { a: 0, b: 0 };
    return events.filter((event) => {
        const team = String(event.team).toLowerCase();
        if (!(team in last)) return false;
        const score = Number(event.score);
        const max = Number(finalScores?.[team]);
        if (!(score > last[team]) || (Number.isFinite(max) && score > max)) return false;
        last[team] = score;
        return true;
    });
}
