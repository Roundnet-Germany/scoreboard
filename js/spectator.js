// Spectator view (display.html?org=&court=&theme=spectator - also the default
// display without a stream theme), opened from the overview: the big board
// under one header - back to the overview, what's playing where, and the
// stream's statistics overlay. Each viewer opens it for themselves
// (Scoreboard.setViewerSettings()), the court's own overlay settings for the
// stream stay untouched.

import { get, ref } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase_config.js?v=4";

/** Which viewer settings each panel turns on - only one panel is open at a time.
 *  Score history and match preview are left out for now, the statistics are enough. */
const PANELS = {
    stats: { show_match_statistics: 1 },
};
const ALL_OFF = { show_score_history: 0, show_score_history_chart: 0, show_match_statistics: 0, show_match_preview: 0 };

export function initSpectator(scoreboard, { org, court, channel }) {
    let openPanel = null;

    // Back to the overview: the page we came from if that was it (keeps its
    // filter, search and scroll position), otherwise a fresh one
    const local = new URLSearchParams(window.location.search).has('emulator') ? '?emulator' : '';
    $('.spectator_back').attr('href', `./${local}`).on('click', (event) => {
        let fromOverview = false;
        try {
            const referrer = new URL(document.referrer);
            fromOverview = referrer.origin === window.location.origin && /\/(index\.html)?$/.test(referrer.pathname);
        } catch { /* no or foreign referrer */ }
        if (fromOverview && history.length > 1) {
            event.preventDefault();
            history.back();
        }
    });

    // "Org · Court 3" next to the event name
    const setLocation = (orgName) => {
        const label = [orgName, court ? `Court ${court}` : channel ? `Channel ${channel}` : ''].filter(Boolean).join(' · ');
        $('.spectator_location').text(label);
    };
    setLocation('');
    if (org && /^[\w-]+$/.test(org)) {
        get(ref(db, `orgs/${org}/name`))
            .then((snapshot) => setLocation(snapshot.val() || org))
            .catch(() => setLocation(org));
    }

    function show(panel) {
        openPanel = panel;
        scoreboard.setViewerSettings({ ...ALL_OFF, ...(panel ? PANELS[panel] : {}) });
        $('.spectator_tool').each((_, button) => {
            button.setAttribute('aria-pressed', String(button.dataset.panel === panel));
        });
        $('.spectator_backdrop').toggleClass('hidden', !panel);
        $('html').toggleClass('spectator_panel_open', !!panel);
    }

    $('.spectator_tool').on('click', function () {
        const panel = this.dataset.panel;
        show(openPanel === panel ? null : panel);
    });

    $('.spectator_stats_type button').on('click', function () {
        const type = this.dataset.statsType;
        $('.spectator_stats_type button').each((_, button) => {
            button.setAttribute('aria-pressed', String(button === this));
        });
        scoreboard.setViewerSettings({ match_stats_type: type });
    });

    $('.spectator_backdrop, .spectator_close').on('click', () => show(null));
    $(document).on('keydown', (event) => {
        if (event.key === 'Escape' && openPanel) show(null);
    });

    show(null);
}
