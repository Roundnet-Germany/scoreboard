// What a court is doing right now, derived from its match-<channel> data alone -
// shared by the live overview (overview.html) and the input panel. No DOM,
// no Firebase, so it runs under `node --test` as well.

/**
 * A running match whose updated_at hasn't moved for this long counts as
 * inactive. Shorter than the Playerzone's 20 minutes on purpose: a court has
 * a score change every few minutes while a game is on, so 10 quiet minutes
 * means nobody is counting anymore.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** A decided match stays "just finished" this long after its last change. */
export const FINISHED_VISIBLE_MS = 20 * 60 * 1000;

// Fixed durations for the shared timeout/medical/break timer - matches
// led_scoreboard/include/score_actions.h's BREAK/TIMEOUT/MEDICAL_*_MS
// exactly. Never sent over the wire; every reader (this page, the LED
// board, the manager server) keeps its own copy so match-<channel>/timer
// only ever has to say *which* timer is running, not how long it lasts.
export const TIMER_DURATIONS_MS = { timeout: 60_000, medical: 300_000, break: 180_000 };
export const TIMER_LABELS = { timeout: 'Timeout', medical: 'Medical Timeout', break: 'Break' };

export const MAX_SETS = 7;

// Same convention as led_scoreboard/include/firebase.h's _parseSetMode() and
// the manager server's setModeToFormat() (firebaseBridge.js): 0=BO1 (never
// auto-starts a break), 1=2 sets (always does), 2=BO3 (only while the match
// isn't already decided).
export function setModeToFormat(raw) {
    const text = String(raw || '').trim();
    if (!text) return 2;
    const lower = text.toLowerCase();
    if (text === '1' || /\b1\s*set\b/.test(lower)) return 0;
    if (text === '2' || /\b2\s*sets?\b/.test(lower)) return 1;
    return 2; // any other value (e.g. "3", "Best of 3") -> BO3
}

/** Scores may arrive as numbers or numeric strings (LED boards, old data). */
const toScore = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** win_points / hardcap with the input panel's defaults. */
export function gameSettingsOf(match) {
    const settings = match?.game_settings || {};
    const winPoints = Number(settings.win_points) > 0 ? Number(settings.win_points) : 15;
    const hardcap = Number(settings.hardcap) > 0 ? Number(settings.hardcap) : 21;
    return { winPoints, hardcap, minMargin: 2, format: setModeToFormat(settings.set_mode) };
}

/**
 * Winner of a set ('a' | 'b') or null - same rules as Scoreboard.setWinner():
 * the hardcap only counts when it sits above the win score.
 */
export function setWinner(a, b, { winPoints, hardcap, minMargin }) {
    if (hardcap > winPoints && a !== b && (a >= hardcap || b >= hardcap)) return a > b ? 'a' : 'b';
    if ((a >= winPoints || b >= winPoints) && Math.abs(a - b) >= minMargin) return a > b ? 'a' : 'b';
    return null;
}

/** Winning score reached without the 2-point margin, or the hardcap reached - serve then changes every point. */
export function isOvertime(a, b, { winPoints, hardcap, minMargin }) {
    if (hardcap > winPoints && a !== b && (a >= hardcap || b >= hardcap)) return true;
    if (a >= winPoints || b >= winPoints) return Math.abs(a - b) < minMargin;
    return false;
}

/**
 * Who serves next in a set: { team: 'a'|'b', serveNumber: 1|2, single: boolean }
 * or null without a starting server. Team level only - derived from the score
 * and the set's starting_server ('a'/'b' = players of team A, 'c'/'d' = team B),
 * so no event history is needed. First serve of a set is a single serve, then
 * the serve changes every two points; in overtime after every point.
 */
export function serveInfo(a, b, startingServer, settings) {
    if (!startingServer) return null;
    const startingTeam = startingServer === 'a' || startingServer === 'b' ? 'a' : 'b';
    const otherTeam = startingTeam === 'a' ? 'b' : 'a';
    const totalPoints = a + b;
    if (isOvertime(a, b, settings)) {
        return { team: totalPoints % 2 === 0 ? startingTeam : otherTeam, serveNumber: 1, single: true };
    }
    if (totalPoints === 0) return { team: startingTeam, serveNumber: 1, single: true };
    const servesAfterFirst = totalPoints - 1;
    const team = Math.floor(servesAfterFirst / 2) % 2 === 0 ? otherTeam : startingTeam;
    return { team, serveNumber: (servesAfterFirst % 2) + 1, single: false };
}

/** Whether these set results end the match, and who won it ('a' | 'b' | null for a 1:1 in 2-set mode). */
function matchResult(winners, format) {
    const won = { a: winners.filter((w) => w === 'a').length, b: winners.filter((w) => w === 'b').length };
    let over;
    if (format === 0) over = won.a + won.b >= 1;
    else if (format === 1) over = winners[0] != null && winners[1] != null;
    else over = won.a >= 2 || won.b >= 2;
    const winner = !over || won.a === won.b ? null : (won.a > won.b ? 'a' : 'b');
    return { over, winner, won };
}

/**
 * Summary of one court's match for the overview.
 * @param {Object|null} match - match-<channel> (without event_history)
 * @param {number} now - current server time in ms (Date.now() + serverTimeOffset)
 * @returns {{
 *   status: 'live'|'ready'|'finished'|'idle',
 *   activeSet: number,
 *   sets: Array<{ set: number, a: number, b: number, winner: 'a'|'b'|null, active: boolean }>,
 *   setsWon: { a: number, b: number },
 *   matchOver: boolean, winner: 'a'|'b'|null,
 *   pointFor: null | { team: 'a'|'b', kind: 'set'|'match' }[],
 *   serve: null | { team: 'a'|'b', serveNumber: 1|2, single: boolean },
 *   hasPoints: boolean,
 *   updatedAt: number|null, age: number|null,
 *   timer: null | { type: string, label: string, remainingMs: number },
 *   squad: { a: number, b: number },
 * }}
 */
export function summarizeMatch(match, now) {
    const settings = gameSettingsOf(match);
    const score = match?.score || {};
    const activeSet = Math.min(Math.max(parseInt(match?.active_set, 10) || 1, 1), MAX_SETS);

    // Sets up to the active one, plus any later one that already has points
    const sets = [];
    for (let set = 1; set <= MAX_SETS; set++) {
        const a = toScore(score[`set_${set}`]?.team_a_score);
        const b = toScore(score[`set_${set}`]?.team_b_score);
        if (set > activeSet && a === 0 && b === 0) continue;
        sets.push({ set, a, b, winner: setWinner(a, b, settings), active: set === activeSet });
    }
    const hasPoints = sets.some((s) => s.a > 0 || s.b > 0);

    const { over: matchOver, winner, won: setsWon } = matchResult(sets.map((s) => s.winner), settings.format);

    // Set/match point: one more point for a team would win the active set (and maybe the match)
    let pointFor = null;
    const current = sets.find((s) => s.active);
    if (!matchOver && current && current.winner == null) {
        pointFor = ['a', 'b'].flatMap((team) => {
            const a = current.a + (team === 'a' ? 1 : 0);
            const b = current.b + (team === 'b' ? 1 : 0);
            if (setWinner(a, b, settings) !== team) return [];
            const winners = sets.map((s) => (s.active ? team : s.winner));
            const result = matchResult(winners, settings.format);
            return [{ team, kind: result.over && result.winner === team ? 'match' : 'set' }];
        });
        if (pointFor.length === 0) pointFor = null;
    }

    // Serve only while a set is being played
    const serve = !matchOver && current && current.winner == null
        ? serveInfo(current.a, current.b, score[`set_${activeSet}`]?.starting_server, settings)
        : null;

    const updatedAt = Number(match?.updated_at) || null;
    const age = updatedAt ? Math.max(0, now - updatedAt) : null;

    let timer = null;
    const timerType = match?.timer?.type;
    const startedAt = Number(match?.timer?.started_at);
    if (TIMER_DURATIONS_MS[timerType] && startedAt) {
        const remainingMs = startedAt + TIMER_DURATIONS_MS[timerType] - now;
        if (remainingMs > 0) timer = { type: timerType, label: TIMER_LABELS[timerType], remainingMs };
    }

    const squadA = toScore(score.squad_score?.team_a_score);
    const squadB = toScore(score.squad_score?.team_b_score);

    let status;
    if (age == null || age >= (matchOver ? FINISHED_VISIBLE_MS : STALE_AFTER_MS)) status = 'idle';
    else if (matchOver) status = 'finished';
    else if (!hasPoints) status = 'ready';
    else status = 'live';

    return {
        status,
        activeSet,
        sets,
        setsWon,
        matchOver,
        winner,
        pointFor,
        serve,
        hasPoints,
        updatedAt,
        age,
        timer,
        squad: { a: squadA, b: squadB },
    };
}
