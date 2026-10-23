// Automatic squad score (admin_settings.group_score_mode = 'auto'), input panel only.
//
// Watches every court that carries a subgame of the same Playerzone main game
// (found via live_games, which lists main_game_id per game) plus the own court,
// and reports the merged subgame results - Scoreboard then writes the squad
// score and the results into its own match-<channel>, so every display (boards,
// overlays, LED boards, the overview) shows it without knowing about any of this.
// Merging and counting: mergeSquadResults() / squadScoreFromResults() in squadGroups.js.

import { ref, query, orderByChild, equalTo, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase_config.js?v=4";
import { summarizeMatch } from "./matchStatus.js?v=4";
import { mergeSquadResults } from "./squadGroups.js?v=4";

/** The parts of a sibling court's match that the results need. */
const FIELDS = ['score', 'game_settings', 'active_set', 'teams_info', 'playerzone', 'squad_auto', 'updated_at'];

/** Several courts changing at once (set end, reload) are merged into one update. */
const UPDATE_DELAY_MS = 300;

export class AutoSquadScore {
    /**
     * @param {Function} onUpdate - ({ channel, mainGameId, results, own }) with
     *        `own` the watched court's own match data (the FIELDS above)
     */
    constructor(onUpdate) {
        this.onUpdate = onUpdate;
        this.key = null;
        this.unsubscribeIndex = null;
        /** channel -> { data, unsubscribe: [fn] } */
        this.courts = new Map();
        this.timeout = null;
    }

    /** Watch the subgames of `mainGameId` for `channel`, or stop with null. Cheap to call on every update. */
    watch(channel, mainGameId) {
        const key = channel && mainGameId ? `${channel}:${mainGameId}` : null;
        if (key === this.key) return;
        this.stop();
        this.key = key;
        if (!key) return;
        this.channel = channel;
        this.mainGameId = mainGameId;

        // The own court always, the others while live_games lists them for this main game
        this.syncCourts([channel]);
        const siblings = query(ref(db, 'live_games'), orderByChild('main_game_id'), equalTo(mainGameId));
        this.unsubscribeIndex = onValue(siblings, (snapshot) => {
            const channels = Object.values(snapshot.val() || {}).map((entry) => Number(entry?.channel)).filter(Boolean);
            this.syncCourts([channel, ...channels]);
        }, (err) => console.warn('[AutoSquadScore] live_games:', err?.code || err?.message));
    }

    syncCourts(channels) {
        const wanted = new Set(channels);
        for (const channel of wanted) {
            if (this.courts.has(channel)) continue;
            const court = { data: {}, unsubscribe: [] };
            this.courts.set(channel, court);
            for (const field of FIELDS) {
                court.unsubscribe.push(onValue(ref(db, `match-${channel}/${field}`), (snapshot) => {
                    court.data[field] = snapshot.val();
                    this.scheduleUpdate();
                }, (err) => console.warn(`[AutoSquadScore] match-${channel}/${field}:`, err?.code || err?.message)));
            }
        }
        // A court that dropped out of live_games keeps counting through its own squad_auto,
        // which is only read while it's watched - so watched courts stay until the main game changes
    }

    scheduleUpdate() {
        clearTimeout(this.timeout);
        this.timeout = setTimeout(() => {
            if (!this.key) return;
            const matches = Array.from(this.courts.values()).map((court) => court.data);
            const now = Date.now();
            const results = mergeSquadResults(this.mainGameId, matches, (match) => summarizeMatch(match, now));
            this.onUpdate({
                channel: this.channel,
                mainGameId: this.mainGameId,
                results,
                own: this.courts.get(this.channel)?.data || {},
            });
        }, UPDATE_DELAY_MS);
    }

    stop() {
        clearTimeout(this.timeout);
        this.unsubscribeIndex?.();
        this.unsubscribeIndex = null;
        for (const court of this.courts.values()) court.unsubscribe.forEach((unsubscribe) => unsubscribe());
        this.courts.clear();
        this.key = null;
    }
}
