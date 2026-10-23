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

/** Phones (narrow or low screens): the statistics as the desktop layout, scaled down. */
const PHONE_QUERY = '(max-width: 820px), (max-height: 520px)';
/** Room left around the statistics on a phone, in px. */
const FIT_MARGIN = 12;
/** Layout width of the statistics on a phone: the desktop's, up to this on long screens. */
const FIT_BASE_WIDTH = 1280;
const FIT_MAX_WIDTH = 1900;

/**
 * On phones: the statistics at their desktop size, scaled down as a whole to
 * fit the screen, and always in landscape - turned while the phone is held
 * upright (css/style-spectator.css, html.stats_fit / .stats_rotated).
 */
/** Longest slide-in inside an overlay (delay + duration, css/style-output.css .animate) plus its own 400ms delay, in ms. */
const OVERLAY_SETTLE_MS = 2000;
let settleTimeout = null;

/**
 * Keeps the statistics' scrollbar from shifting the content: room for it only
 * if they're too tall for the screen (measured while nothing slides - parts
 * sliding in stick out and would count), no scrolling while they slide in.
 */
function updateNeedsScroll() {
    const overlay = document.querySelector('.match_statistics');
    if (!overlay || overlay.classList.contains('settling')) return;
    const fits = document.documentElement.classList.contains('stats_fit');
    // Layout heights of the parts (offsetTop/-Height ignore the slide-in
    // transforms, which scrollHeight would count while they still run)
    const contentHeight = Math.max(0, ...[...overlay.children].map((part) => part.offsetTop + part.offsetHeight));
    overlay.classList.toggle('needs_scroll', !fits && contentHeight > overlay.clientHeight + 1);
}

function settleOverlay() {
    const overlay = document.querySelector('.match_statistics');
    if (!overlay) return;
    updateNeedsScroll();
    overlay.classList.add('settling');
    clearTimeout(settleTimeout);
    settleTimeout = setTimeout(() => {
        overlay.classList.remove('settling');
        updateNeedsScroll();
    }, OVERLAY_SETTLE_MS);
}

function fitStatsToScreen() {
    const overlay = document.querySelector('.match_statistics');
    if (!overlay) return;
    const html = document.documentElement;
    const phone = window.matchMedia(PHONE_QUERY).matches;
    html.classList.toggle('stats_fit', phone);
    if (!phone) {
        html.classList.remove('stats_rotated');
        overlay.style.removeProperty('--stats-scale');
        overlay.style.removeProperty('--stats-width');
        return;
    }
    const upright = window.innerHeight > window.innerWidth;
    html.classList.toggle('stats_rotated', upright);
    const roomX = (upright ? window.innerHeight : window.innerWidth) - 2 * FIT_MARGIN;
    const roomY = (upright ? window.innerWidth : window.innerHeight) - 2 * FIT_MARGIN;

    // As wide as the screen's proportions allow - measured at the desktop
    // width each time, so the result doesn't depend on the previous fit.
    // Layout sizes: scale and rotation don't change them.
    overlay.style.setProperty('--stats-width', `${FIT_BASE_WIDTH}px`);
    const baseHeight = overlay.offsetHeight;
    if (!baseHeight) return;
    const width = Math.round(Math.min(FIT_MAX_WIDTH, Math.max(FIT_BASE_WIDTH, baseHeight * roomX / roomY)));
    overlay.style.setProperty('--stats-width', `${width}px`);
    const height = overlay.offsetHeight;
    overlay.style.setProperty('--stats-scale', Math.min(1, roomX / width, roomY / height));
}

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
        if (panel && panel !== openPanel) settleOverlay();
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

    // What the statistics cover: the match, or one set played so far / running.
    // Kept as 'match' or a set number (match_stats_type takes either).
    let statsType = 'match';
    let renderedSetCount = -1;
    const $statsTypes = $('.spectator_stats_type');

    function renderStatsTypes() {
        const setCount = Math.max(scoreboard.getCompletedSetsCount(), Number(scoreboard.active_set) || 1);
        // A set that isn't there any more (a new match on the court): back to the match
        if (statsType !== 'match' && statsType > setCount) {
            statsType = 'match';
            scoreboard.setViewerSettings({ match_stats_type: 'match' });
        }
        if (setCount !== renderedSetCount) {
            renderedSetCount = setCount;
            const buttons = [{ type: 'match', label: 'Match' }];
            for (let set = 1; set <= setCount; set++) buttons.push({ type: set, label: `Set ${set}` });
            $statsTypes[0]?.replaceChildren(...buttons.map(({ type, label }) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.statsType = String(type);
                button.textContent = label;
                return button;
            }));
        }
        $statsTypes.find('button').each((_, button) => {
            button.setAttribute('aria-pressed', String(button.dataset.statsType === String(statsType)));
        });
    }

    $statsTypes.on('click', 'button', function () {
        const type = this.dataset.statsType;
        statsType = type === 'match' ? 'match' : Number(type);
        scoreboard.setViewerSettings({ match_stats_type: type });
        renderStatsTypes();
    });
    scoreboard.onRender = renderStatsTypes;
    renderStatsTypes();

    $('.spectator_backdrop, .spectator_close').on('click', () => show(null));

    // Statistics on phones: refit on rotation/resize and whenever their content changes height
    // ... and keep the scrollbar's room up to date (content or screen height changed)
    const refit = () => { fitStatsToScreen(); updateNeedsScroll(); };
    window.addEventListener('resize', refit);
    const statsOverlay = document.querySelector('.match_statistics');
    if (statsOverlay && 'ResizeObserver' in window) {
        const observer = new ResizeObserver(refit);
        observer.observe(statsOverlay);
        statsOverlay.querySelectorAll(':scope > *').forEach((part) => observer.observe(part));
    }
    refit();
    $(document).on('keydown', (event) => {
        if (event.key === 'Escape' && openPanel) show(null);
    });

    show(null);
}
