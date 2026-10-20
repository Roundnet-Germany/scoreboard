// Squad games (liga) in the live overview: a squad game is a Playerzone main
// game whose subgames (e.g. Men / Women / Mixed) run as separate games, often
// on different courts. Every subgame carries the same
// match-<channel>/playerzone.main_game_id, which is how they're found here.
// No DOM, no Firebase, so it runs under `node --test` as well.
//
// Team sides: the Playerzone's game_details() puts the main game's team1 on
// team_a of every subgame (lineup slot 1 -> the subgame's phase_team1, names
// taken from the main game), so team_a is normally the same squad everywhere.
// The names on a court can still be edited by hand, so the sides are matched
// by name and only fall back to "same side" when the names don't tell.

const STATUS_ORDER = { live: 0, ready: 1, finished: 2, idle: 3 };

/** Name as compared between subgames - case, spacing and accents don't count. */
export function normalizeTeamName(name) {
    return String(name || '')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Whether a subgame's team_a is the reference's team_b (and vice versa).
 * Only when both names say so - anything unclear counts as the same side,
 * which is what the Playerzone sends.
 */
export function isFlipped(reference, names) {
    const ref = { a: normalizeTeamName(reference.a), b: normalizeTeamName(reference.b) };
    const own = { a: normalizeTeamName(names.a), b: normalizeTeamName(names.b) };
    if (!ref.a || !ref.b || ref.a === ref.b) return false;
    if (own.a === ref.a || own.b === ref.b) return false;
    return own.a === ref.b && own.b === ref.a;
}

/** Decided subgames per squad (in the reference's sides): winner from summarizeMatch(). */
export function squadScore(members) {
    const score = { a: 0, b: 0 };
    for (const { view, flipped } of members) {
        if (view.winner !== 'a' && view.winner !== 'b') continue;
        const team = flipped ? (view.winner === 'a' ? 'b' : 'a') : view.winner;
        score[team]++;
    }
    return score;
}

/**
 * Groups court views into overview entries. Courts whose main_game_id is the
 * same (and set) become one squad entry once there are at least two of them;
 * everything else stays a single court.
 *
 * @param {Array<{ channel: number, mainGameId: number|null, status: string,
 *   winner: 'a'|'b'|null, teams: { a: { name: string }, b: { name: string } },
 *   courtNumber: number }>} views
 * @returns {Array<
 *   { type: 'court', key: string, status: string, view: Object } |
 *   { type: 'squad', key: string, status: string, mainGameId: number,
 *     teams: { a: string, b: string }, score: { a: number, b: number },
 *     decided: number, members: Array<{ view: Object, flipped: boolean }> }
 * >} in the order of `views` (a squad where its first subgame was)
 */
export function groupSquadGames(views) {
    const byMainGame = new Map();
    for (const view of views) {
        if (!view.mainGameId) continue;
        if (!byMainGame.has(view.mainGameId)) byMainGame.set(view.mainGameId, []);
        byMainGame.get(view.mainGameId).push(view);
    }

    const entries = [];
    const placed = new Set();
    for (const view of views) {
        const siblings = view.mainGameId ? byMainGame.get(view.mainGameId) : null;
        if (!siblings || siblings.length < 2) {
            entries.push({ type: 'court', key: `court-${view.channel}`, status: view.status, view });
            continue;
        }
        if (placed.has(view.mainGameId)) continue;
        placed.add(view.mainGameId);

        const ordered = [...siblings].sort((x, y) => (x.courtNumber ?? 0) - (y.courtNumber ?? 0) || x.channel - y.channel);
        const reference = { a: ordered[0].teams.a.name, b: ordered[0].teams.b.name };
        const members = ordered.map((member) => ({
            view: member,
            flipped: isFlipped(reference, { a: member.teams.a.name, b: member.teams.b.name }),
        }));
        // The squad sits where its most active subgame belongs
        const status = ordered.map((member) => member.status)
            .sort((x, y) => STATUS_ORDER[x] - STATUS_ORDER[y])[0];
        entries.push({
            type: 'squad',
            key: `squad-${view.mainGameId}`,
            status,
            mainGameId: view.mainGameId,
            teams: reference,
            score: squadScore(members),
            decided: members.filter(({ view: member }) => member.winner).length,
            members,
        });
    }
    return entries;
}

// ------------------------------- Automatic squad score ------------------------------- //
//
// With admin_settings.group_score_mode = 'auto' the input panel counts the
// squad score itself from the subgames of its main game. A subgame drops out
// of live_games and match-<channel>/playerzone on "End game", so every court
// keeps the results it has seen under match-<channel>/squad_auto =
// { main_game_id, results: { <game_id>: { winner: <team name>, side: 'a'|'b' } } }
// and the courts share them through each other's squad_auto.

/**
 * All known subgame results of a main game, from the courts' data.
 * Stored results (any court's squad_auto for this main game) come first; a
 * court that currently carries a subgame overrides them for that game - with
 * its winner once decided, or removing it while it isn't (a corrected score).
 * @param {number} mainGameId
 * @param {Array<Object>} matches - match-<channel> data of the courts involved
 * @param {Function} summarize - summarizeMatch(match) for the current time
 * @returns {Object<string, { winner: string, side: 'a'|'b' }>}
 */
export function mergeSquadResults(mainGameId, matches, summarize) {
    const results = {};
    for (const match of matches) {
        const stored = match?.squad_auto;
        if (Number(stored?.main_game_id) !== mainGameId) continue;
        for (const [gameId, result] of Object.entries(stored.results || {})) {
            if (result?.side === 'a' || result?.side === 'b') {
                results[gameId] = { winner: String(result.winner || ''), side: result.side };
            }
        }
    }
    for (const match of matches) {
        const link = match?.playerzone;
        if (Number(link?.main_game_id) !== mainGameId || !link?.game_id) continue;
        const gameId = String(link.game_id);
        const summary = summarize(match);
        if (summary.matchOver && summary.winner) {
            const winner = String(match.teams_info?.[`team_${summary.winner}`]?.name || '');
            results[gameId] = { winner, side: summary.winner };
        } else {
            delete results[gameId];
        }
    }
    return results;
}

/**
 * Squad score of a court from the subgame results: a result counts for the
 * team whose name won it, and only falls back to its side when the names
 * don't tell (subgames carry the squads' names, see the top of this file).
 */
export function squadScoreFromResults(results, names) {
    const own = { a: normalizeTeamName(names?.a), b: normalizeTeamName(names?.b) };
    const score = { a: 0, b: 0 };
    for (const { winner, side } of Object.values(results || {})) {
        const name = normalizeTeamName(winner);
        if (name && own.a !== own.b && name === own.a) score.a++;
        else if (name && own.a !== own.b && name === own.b) score.b++;
        else score[side]++;
    }
    return score;
}
