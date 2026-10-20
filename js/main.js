// import firebase config
import { get, ref, update, onValue, runTransaction, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth, signOut } from "./firebase_config.js?v=4";
import { resolveCourt, watchAccount, login, withTimeout } from "./auth.js?v=4";
import { Scoreboard } from "./Scoreboard.js?v=4";

/**
 * Theme registry.
 *
 * `brand_logo` is optional and overrides the federation logo in the top-right
 * of the overlay headers (see setTheme() in Scoreboard.js); themes that omit
 * it keep the Roundnet Germany badge that is hardcoded in display.html.
 */
// A new stream theme also goes into display.html's streamThemes (keeps the
// page transparent while loading instead of the spectator board's dark).
export const themes = {
    // The big board for spectators, opened from the overview, and the display
    // without a stream theme (e.g. a screen at the court): one header back to
    // the overview, plus the stream overlays (score history, statistics,
    // preview) to open per viewer - see js/spectator.js. Replaces the old
    // "full" theme; ?theme=full links show this one (see Scoreboard.setTheme()).
    'spectator': {
        'html_structure': 'full',
        'css_path': 'css/style-spectator.css?v=4',
        'spectator': true
    },
    'small': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v5.css?v=4'
    },
    'rg': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v1.css?v=4'
    },
    'tops': {
        'html_structure': 'horizontal_score',
        'css_path': 'css/style-v2.css?v=4'
    },
    'france': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v4-france.css?v=4'
    },
    'eura': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v5-eura.css?v=4'
    },
    'irf': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-irf.css?v=4',
        // The overlay headers run light in this theme, so the mark with its
        // original black lettering is the one that reads there.
        // img/irf_logo_white.png is the same mark with that lettering
        // inverted, for a dark header.
        'brand_logo': 'img/irf_logo_full.png',
        // Fixed event mark, shown ahead of the event name. Two cuts of the
        // same artwork, named for the ground they sit on: the board's strip
        // is dark, the overlay headers are light, and the mark's white
        // details vanish on the wrong one.
        'event_logo': {
            'dark_bg': 'img/irf_event_logo_dark_bg.png',
            'light_bg': 'img/irf_event_logo_light_bg.png'
        }
    },
}

/** Fallback for themes without their own `brand_logo` (matches display.html). */
export const DEFAULT_BRAND_LOGO = 'img/rg_logo_white.png';

// Debug: set to true for console logs of the auth/data flow; also exposed to Scoreboard
const AUTH_DEBUG = false;
if (typeof window !== 'undefined') window.AUTH_DEBUG = AUTH_DEBUG;

// Initialize variables for global usage
let loggedInUser;
let scoreboard;
let $banner, $logoutButton, $userString;

// =========================================== Page Load ======================================= //

$(document).ready(async function () {
    $banner = $('.banner');
    $logoutButton = $('button#logout');
    $userString = $('header #username');

    // Determine board type
    const type = $('html').attr('type') === 'output' ? 'output' : 'input';

    // Get URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const urlChannel = parseInt(urlParams.get('channel'), 10);
    const themeSelection = urlParams.get('theme');

    // Internal channel number: ?org=&court= (resolved via orgs/<org>/courts)
    // takes precedence over ?channel=. Without either, the display uses
    // channel 1; the input panel picks the account's first court after login.
    let channelSelection = isNaN(urlChannel) ? (type === 'output' ? 1 : null) : urlChannel;
    const urlOrg = urlParams.get('org');
    const urlCourt = urlParams.get('court');
    if (urlOrg && urlCourt) {
        const channel = await resolveCourt(urlOrg, urlCourt);
        // For an invalid link, show nothing rather than silently someone else's match
        channelSelection = channel;
        if (channel == null) {
            console.warn(`[Data] Court ${urlCourt} of "${urlOrg}" not found - not showing any match.`);
            showToast("⚠️", `Court ${urlCourt} of "${urlOrg}" not found.`);
        }
    }

    // Create scoreboard immediately
    scoreboard = new Scoreboard(type, $('.scoreboard'), channelSelection, themeSelection);

    // Spectator view: bar, overlay buttons and the shared login (for the input panel link)
    if (type === 'output' && themes[scoreboard.theme]?.spectator) {
        import("./spectator.js?v=4").then(({ initSpectator }) => initSpectator(scoreboard, {
            org: urlOrg, court: urlCourt, channel: channelSelection,
        }));
    }

    // Wait for authentication and set user for input type
    if (type === 'input') {
        await handleAuthentication(scoreboard);
    }

    // Close toast message
    $('.banner_close_button').click(() => {
        $banner.fadeOut(100);
    });
});

// ========================================= Data Functions ===================================== //

/**
 * Live listener on match-<channel>: Firebase keeps a WebSocket connection open
 * and only calls onData when something actually changed (plus once right away
 * with the current state). Own writes also come back locally right away,
 * without a round trip to the server.
 * @returns {Function} Unsubscribe function that detaches the listener
 */
export function subscribeToMatch(channel, onData) {
    if (AUTH_DEBUG) console.log("[Data] subscribeToMatch, channel:", channel);
    return onValue(ref(db, `match-${channel}`), (snapshot) => {
        onData(snapshot.val());
    }, (err) => {
        console.warn("[Data] subscribeToMatch error, channel:", channel, err?.code || err?.message, err);
    });
}

/** Multi-path update at the root. Resolves to true if it was saved. */
export async function writeData(newData) {
    try {
        await update(ref(db), newData);
        console.log("Data updated successfully.");
        return true;
    } catch (error) {
        console.error("Error updating user data:", error);
        if (error?.code === 'PERMISSION_DENIED') {
            showToast("❌", "Not saved - this account has no write access to this court.");
        }
        return false;
    }
}

/** Events kept per match: everything before the last reset is dropped, and at most this many after it. */
const EVENT_HISTORY_MAX = 1000;

/** event_history as an array - Firebase hands back an object instead once indices have gaps. */
export function normalizeEventHistory(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map((key) => value[key]).filter(Boolean);
    }
    return [];
}

/**
 * Changes match-<channel>/event_history atomically: `mutate` gets the current
 * list (from the server, re-run if another device wrote in between) and
 * changes it in place. Two operators on the same court therefore never
 * overwrite each other's events, unlike writing the whole list. Resolves to
 * true if it was saved.
 */
export async function changeEventHistory(channel, mutate) {
    try {
        await runTransaction(ref(db, `match-${channel}/event_history`), (current) => {
            const list = normalizeEventHistory(current);
            mutate(list);
            let lastReset = -1;
            list.forEach((event, index) => { if (event.type === 'reset') lastReset = index; });
            const kept = list.slice(Math.max(lastReset, 0));
            return kept.slice(-EVENT_HISTORY_MAX);
        });
        return true;
    } catch (error) {
        console.error("Error updating the event history:", error);
        return false;
    }
}

/**
 * Calls onChange('connecting' | 'online' | 'offline') whenever the connection
 * to Firebase changes. Writes made while offline are kept and sent once it's
 * back - but only as long as the tab stays open.
 */
/** A round trip slower than this (or a ping that doesn't answer in time) counts as a poor connection. */
const POOR_RTT_MS = 1000;
const PING_TIMEOUT_MS = 3000;
const PING_INTERVAL_MS = 8000;

export function watchConnection(onChange) {
    let connected = false;
    let wasConnected = false;
    let poor = false;
    let last = null;
    const report = () => {
        const state = connected ? (poor ? 'poor' : 'online') : (wasConnected || !navigator.onLine ? 'offline' : 'connecting');
        if (state !== last) onChange(last = state);
    };

    // Firebase's own view: socket to the database up or not
    onValue(ref(db, '.info/connected'), (snapshot) => {
        connected = snapshot.val() === true;
        if (connected) wasConnected = true;
        report();
    });
    // The first "not connected" right after loading only means "not yet"
    setTimeout(() => { wasConnected = true; report(); }, 5000);

    // The browser notices a lost network faster than the socket does
    window.addEventListener('offline', () => { connected = false; wasConnected = true; report(); });
    window.addEventListener('online', report);

    // Quality: time a tiny read now and then (orgs/__ping doesn't exist and
    // nothing listens to it, so it always goes to the server), plus the
    // browser's own estimate where there is one (Chrome)
    const ping = async () => {
        if (!connected) return;
        const started = performance.now();
        let rtt;
        try {
            await withTimeout(get(ref(db, 'orgs/__ping')), PING_TIMEOUT_MS);
            rtt = performance.now() - started;
        } catch {
            rtt = Infinity;
        }
        const slowNetwork = ['slow-2g', '2g'].includes(navigator.connection?.effectiveType);
        poor = rtt > POOR_RTT_MS || slowNetwork;
        report();
    };
    setInterval(ping, PING_INTERVAL_MS);
    navigator.connection?.addEventListener?.('change', ping);
    report();
}

/** One-off read of a path, null if it doesn't exist. */
export async function readData(path) {
    return (await get(ref(db, path))).val();
}

export { serverTimestamp };

// Shared timeout/medical/break timer, synced through match-<channel>/timer -
// same node the LED scoreboard firmware and its manager server read/write
// (see the mono-repo CLAUDE.md / led_scoreboard's firebase.h). No duration
// is written here: every reader keeps its own copy of the same fixed
// durations the firmware already hardcodes (60s timeout, 5min medical,
// 3min break), so this only ever needs to say *which* timer is running.
// started_at uses Firebase's server-timestamp sentinel so every reader
// (this page's own output display, the LED board, the manager server)
// computes "time remaining" against the same clock regardless of whose
// device's local clock started it.
export async function writeTimerState(channel, type) {
    try {
        // updated_at: the Playerzone hides a live game whose court hasn't changed for a while
        await update(ref(db), type ? {
            [`/match-${channel}/timer/type`]: type,
            [`/match-${channel}/timer/started_at`]: serverTimestamp(),
            [`/match-${channel}/updated_at`]: serverTimestamp(),
        } : {
            [`/match-${channel}/timer`]: null,
            [`/match-${channel}/updated_at`]: serverTimestamp(),
        });
        console.log("Timer state updated:", type || "(cleared)");
    } catch (error) {
        console.error("Error updating timer state:", error);
        if (error?.code === 'PERMISSION_DENIED') {
            showToast("❌", "Timer not saved - this account has no write access to this court.");
        }
    }
}

// ========================================= Global Functions ===================================== //

async function handleAuthentication(scoreboard) {
    // Set on form login, only so that "Signed in as" is shown afterwards
    let signedInViaForm = false;

    // The form only signs in - loading the account and switching the UI happens
    // in watchAccount(), whether the session is new or from an earlier visit
    // (also one started on the overview - the session is shared, see auth.js).
    $('form#login').on('submit', async function (e) {
        e.preventDefault();
        const $submitBtn = $('#auth #submit');
        const originalText = $submitBtn.text();
        $submitBtn.prop('disabled', true).addClass('is-loading').text('Signing in…');
        // Set beforehand: watchAccount() often fires before login() returns
        signedInViaForm = true;
        try {
            const error = await login($('#auth #email').val().trim(), $('#auth #password').val());
            if (error) {
                signedInViaForm = false;
                showToast("❌", error);
            }
        } finally {
            $submitBtn.prop('disabled', false).removeClass('is-loading').text(originalText);
        }
    });

    return new Promise((resolve) => {
        watchAccount((user, reason) => {
            if (AUTH_DEBUG) console.log("[Auth] watchAccount", user ? "user=" + user.email : reason);

            if (reason === 'signed-out') {
                // Also covers an expired/revoked session without reload: drop the previous user's courts
                loggedInUser = null;
                scoreboard.user = null;
                scoreboard.updateAvailableChannels();
                $userString.text('');
                $('header #user_email').text('');
                $('header #admin_tag').hide();
                $('#auth').show();
                scoreboard.setInputLoading(false);
                return;
            }

            if (!user || user.courts.length === 0) {
                showToast("⚠️", user
                    ? "No courts are assigned to this account yet."
                    : reason === 'error' ? "Couldn't load this account - please try again."
                        : "This account isn't linked to an organisation yet.");
                signOut(auth);
                return;
            }

            loggedInUser = user;
            scoreboard.user = user;
            scoreboard.updateAvailableChannels();
            scoreboard.startDataSync();
            scoreboard.playerzonePicker?.start();
            startConnectionStatus();
            $('#auth').hide();
            $userString.text(user.displayName);
            $('header #user_email').text(user.email);
            $('header #admin_tag').toggle(user.isAdmin);
            if (signedInViaForm) showToast("✅", `Signed in as ${user.displayName}`, 2000);
            if (AUTH_DEBUG) console.log("[Auth] eingeloggt:", user.orgId, user.isAdmin ? "(admin)" : "", user.channels);
            resolve(user);
        });
    });
}

/** Connection badge in the input panel's header: [icon, label, tooltip] per state. */
const CONNECTION_STATES = {
    connecting: ['wifi', 'Connecting…', 'Connecting to the database'],
    online: ['wifi', 'Connected', 'Connected - changes are saved right away'],
    poor: ['wifi_2_bar', 'Poor connection', 'Slow connection - changes may take a moment to be saved'],
    offline: ['wifi_off', 'No connection', 'No connection - changes are saved once it is back, as long as this tab stays open'],
};

export function renderConnectionStatus(state) {
    const [icon, label, title] = CONNECTION_STATES[state];
    const $status = $('#connection_status');
    $status.attr('data-state', state).attr('title', title).removeClass('hidden');
    $status.find('.connection_icon').text(icon);
    $status.find('.connection_label').text(label);
}

/** Started once after login. */
let connectionStatusStarted = false;
function startConnectionStatus() {
    if (connectionStatusStarted) return;
    connectionStatusStarted = true;
    watchConnection(renderConnectionStatus);
}

// Toasts often carry text from outside (URL parameters, Playerzone team names
// and error messages) - always set as text, never as HTML.
let toastTimeout = null;
export function showToast(emoji, message, duration) {
    try {
        // Set the animation-duration of the cooldown ring to the show duration
        const showDuration = duration || 5000;
        $banner.find('.icon').text(emoji);
        $banner.find('.progress-ring_circle').css('animation-duration', `${showDuration / 1000}s`);
        $banner.find('p').text(message);
        $banner.fadeIn(100);

        // Fade out banner after the set show duration if not already closed manually -
        // a newer toast restarts the countdown instead of being cut short by the older one's
        clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => {
            $banner.fadeOut(100);
        }, showDuration);
    } catch (error) {
        console.log("Banner shown: " + message);
    }
}

// ========================================= Helper Functions ===================================== //

// The only easing the scoreboard uses (chart slide in/out) - defined here
// instead of loading all of jQuery UI for it.
if (typeof $ !== 'undefined' && !$.easing.easeOutCubic) {
    $.easing.easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
}

export function rgb2hex(rgb) {
    if (/^#[0-9A-F]{6}$/i.test(rgb)) return rgb;
    rgb = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);

    function hex(x) {
        return ("0" + parseInt(x).toString(16)).slice(-2);
    }
    return "#" + hex(rgb[1]) + hex(rgb[2]) + hex(rgb[3]);
}


export function getColorBrightness(hexColor) {
    var r = parseInt(hexColor.substr(1, 2), 16);
    var g = parseInt(hexColor.substr(3, 2), 16);
    var b = parseInt(hexColor.substr(5, 2), 16);

    return (r * 299 + g * 587 + b * 114) / 1000;
}

// Helper function that returns the paths and values to json objects
export function getPathsAndValues(obj, currentPath = '') {
    const result = {};

    for (const key in obj) {
        const value = obj[key];
        // Create the current path without leading dot
        const path = currentPath ? `${currentPath}.${key}` : key;

        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            // Call recursive function to traverse deeper objects
            Object.assign(result, getPathsAndValues(value, path));
        } else {
            // Store the complete path with the value
            result[path] = value;
        }
    }

    return result;
}

// Function to copy text to clipboard
export function copyToClipboard(text) {
    // Create a temporary input field to copy text to clipboard
    const tempInput = $('<input>');
    $('body').append(tempInput);  // Add the input field to the DOM

    tempInput.val(text).select();  // Set the text in the input field and select it
    document.execCommand('copy');  // Copy the text to the clipboard

    tempInput.remove();  // Remove the temporary input field
}
