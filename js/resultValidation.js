// End-of-match result validation, shared with the LED scoreboards and
// RoundnetFranceConnect (the French federation's tournament app). When a
// match is over, the players confirm the final score - on the LED board
// (holding a pedal on its "OK? / HOLD" screen, or its portal) or here - and
// the validator writes
//   match-<channel>/result_validated = { nonce, sets: [[a, b], ...], at }
// RoundnetFranceConnect records exactly that score and answers in
//   match-<channel>/rfc_result = { nonce, status: 'recorded'|'rejected', message?, next?: { team_a, team_b } }
// (next = where each team plays next, already uppercase ASCII for the LED
// font). An answer only counts for the validation carrying the same nonce.
// No DOM, no Firebase, so it runs under `node --test` as well.

import { MAX_SETS } from './matchStatus.js?v=4';

/** Scores may arrive as numbers or numeric strings (LED boards, old data). */
const toScore = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * The score as RoundnetFranceConnect reads it: sets 1..active_set that exist,
 * without trailing 0-0 sets (a next set opened after the match ended).
 * @returns {Array<[number, number]>}
 */
export function validatedSetsOf(match) {
    const score = match?.score || {};
    const activeSet = Math.min(Math.max(parseInt(match?.active_set, 10) || 1, 1), MAX_SETS);
    const sets = [];
    for (let set = 1; set <= activeSet; set++) {
        const entry = score[`set_${set}`];
        if (!entry) break;
        sets.push([toScore(entry.team_a_score), toScore(entry.team_b_score)]);
    }
    while (sets.length && sets[sets.length - 1][0] === 0 && sets[sets.length - 1][1] === 0) sets.pop();
    return sets;
}

function sameSets(x, y) {
    return Array.isArray(x) && x.length === y.length &&
        x.every((set, i) => Array.isArray(set) && toScore(set[0]) === y[i][0] && toScore(set[1]) === y[i][1]);
}

/**
 * @param {Object|null} match - match-<channel>
 * @param {boolean} matchOver - summarizeMatch(match).matchOver
 * @returns {{
 *   canValidate: boolean,
 *   validated: boolean,
 *   answer: null | { status: string, message?: string, next?: { team_a?: string, team_b?: string } },
 *   sets: Array<[number, number]>,
 * }}
 */
export function validationStateOf(match, matchOver) {
    const sets = validatedSetsOf(match);
    const validation = match?.result_validated;
    // A validation only counts for the exact score it was given for - after a
    // correction it's stale, and RoundnetFranceConnect ignores it too.
    const validated = !!validation?.nonce && sameSets(validation.sets, sets);
    const answer = validated && match?.rfc_result?.nonce === validation.nonce ? match.rfc_result : null;
    return { canValidate: !!matchOver && sets.length > 0 && !validated, validated, answer, sets };
}

/** Random 8-hex-digit nonce, same shape as the LED board's. */
export function newNonce(random = () => Math.floor(Math.random() * 0x100000000)) {
    return (random() >>> 0).toString(16).padStart(8, '0');
}

/**
 * Status line for the input panel, or null when there's nothing to say.
 * @returns {null | { text: string, tone: 'pending'|'positive'|'negative' }}
 */
export function validationStatusOf(state, teamNames = {}) {
    if (!state.validated) return null;
    const { answer } = state;
    if (!answer) return { text: 'Result validated - waiting for the tournament app', tone: 'pending' };
    if (answer.status === 'rejected') {
        return { text: `Refused by the tournament app: ${answer.message || 'see the organizers'}`, tone: 'negative' };
    }
    const next = ['a', 'b']
        .filter((team) => answer.next?.[`team_${team}`])
        .map((team) => `${teamNames[team] || `Team ${team.toUpperCase()}`}: ${answer.next[`team_${team}`]}`);
    return { text: ['Result recorded', ...next].join(' · '), tone: 'positive' };
}
