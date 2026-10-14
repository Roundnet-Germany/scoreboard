// import firebase config
import { get, ref, update, remove, onValue, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.5.2/firebase-database.js";
import { db, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "./firebase_config.js?v=3";

import { User } from "./User.js?v=3";
import { Scoreboard } from "./Scoreboard.js?v=3";

/**
 * Theme registry.
 *
 * `brand_logo` is optional and overrides the federation logo in the top-right
 * of the overlay headers (see setTheme() in Scoreboard.js); themes that omit
 * it keep the Roundnet Germany badge that is hardcoded in index.html.
 */
export const themes = {
    'full': {
        'html_structure': 'full',
        'css_path': 'css/style-v3.css?v=3'
    },
    'small': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v5.css?v=3'
    },
    'rg': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v1.css?v=3'
    },
    'tops': {
        'html_structure': 'horizontal_score',
        'css_path': 'css/style-v2.css?v=3'
    },
    'france': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v4-france.css?v=3'
    },
    'eura': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-v5-eura.css?v=3'
    },
    'irf': {
        'html_structure': 'vertical_score',
        'css_path': 'css/style-irf.css?v=3',
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

/** Fallback for themes without their own `brand_logo` (matches index.html). */
export const DEFAULT_BRAND_LOGO = 'img/rg_logo_white.png';

// Debug: auf true setzen für Console-Logs (Auth/Daten-Flow); wird auch für Scoreboard exponiert
const AUTH_DEBUG = true;
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

// ========================================= Orgs & Courts ===================================== //
//
// Every org (federation/organiser) operates its own courts 1..n. Data is still
// stored under match-<channel>, so LED boards and bridges don't need to know
// about any of this - the mapping lives in orgs/<org>/channels/<channel> = <court>.
// Structure and read access: see database.rules.json.

/**
 * Courts of an org as [{ org, orgName, court, channel }], sorted by court.
 * Firebase sometimes returns objects with numeric keys as a sparse array
 * (index = channel) - Object.entries plus the null filter covers both.
 */
function courtsOfOrg(orgId, org) {
    return Object.entries(org?.channels || {})
        .filter(([, court]) => court != null)
        .map(([channel, court]) => ({ org: orgId, orgName: org.name || orgId, court: Number(court), channel: Number(channel) }))
        .sort((a, b) => a.court - b.court);
}

/** Internal channel number for a court of an org, or null. */
async function resolveCourt(orgId, court) {
    if (!/^[\w-]+$/.test(orgId) || !/^\d+$/.test(court)) return null;
    try {
        const snap = await get(ref(db, `orgs/${orgId}`));
        const match = courtsOfOrg(orgId, snap.val()).find((c) => c.court === Number(court));
        return match ? match.channel : null;
    } catch (err) {
        console.warn("[Data] resolveCourt error", orgId, court, err?.code || err?.message);
        return null;
    }
}

/**
 * Loads org, role and courts of the signed-in Firebase user. Admins get the
 * courts of all orgs (their own first). Returns null if the account has no
 * entry, or neither an org nor the admin role.
 */
async function loadAccount(firebaseUser) {
    const [accountSnap, orgsSnap] = await Promise.all([
        get(ref(db, `accounts/${firebaseUser.uid}`)),
        get(ref(db, 'orgs')),
    ]);
    const orgId = accountSnap.val()?.org || null;
    const isAdmin = accountSnap.val()?.role === 'admin';
    const orgs = orgsSnap.val() || {};
    if (!orgId && !isAdmin) return null;

    let courts = courtsOfOrg(orgId, orgs[orgId]);
    if (isAdmin) {
        const otherOrgs = Object.keys(orgs).filter((id) => id !== orgId).sort();
        courts = courts.concat(otherOrgs.flatMap((id) => courtsOfOrg(id, orgs[id])));
    }

    return new User({
        email: firebaseUser.email,
        orgId,
        orgName: orgs[orgId]?.name || (isAdmin ? 'Admin' : orgId),
        courts,
        isAdmin,
    });
}

export async function writeData(newData) {
    try {
        await update(ref(db), newData);
        console.log("Data updated successfully.");
    } catch (error) {
        console.error("Error updating user data:", error);
        if (error?.code === 'PERMISSION_DENIED') {
            showToast("❌", "Not saved - this account has no write access to this court.");
        }
    }
}

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
        if (type) {
            await update(ref(db), {
                [`/match-${channel}/timer/type`]: type,
                [`/match-${channel}/timer/started_at`]: serverTimestamp(),
            });
        } else {
            await remove(ref(db, `match-${channel}/timer`));
        }
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
    // in onAuthStateChanged, whether the session is new or from an earlier visit.
    $('form#login').on('submit', async function (e) {
        e.preventDefault();
        const $submitBtn = $('#auth #submit');
        const originalText = $submitBtn.text();
        $submitBtn.prop('disabled', true).addClass('is-loading').text('Signing in…');
        // Set beforehand: onAuthStateChanged often fires before login() returns
        signedInViaForm = true;
        try {
            if (!await login($('#auth #email').val().trim(), $('#auth #password').val())) {
                signedInViaForm = false;
            }
        } finally {
            $submitBtn.prop('disabled', false).removeClass('is-loading').text(originalText);
        }
    });

    return new Promise((resolve) => {
        onAuthStateChanged(auth, async (firebaseUser) => {
            if (AUTH_DEBUG) console.log("[Auth] onAuthStateChanged", firebaseUser ? "user=" + firebaseUser.email : "user=null");

            if (!firebaseUser) {
                // Also covers an expired/revoked session without reload: drop the previous user's courts
                loggedInUser = null;
                scoreboard.user = null;
                scoreboard.updateAvailableChannels();
                $userString.text('');
                $('header #user_email').text('');
                $('header #admin_tag').hide();
                $('#auth').show();
                return;
            }

            let user = null;
            try {
                user = await loadAccount(firebaseUser);
            } catch (err) {
                console.error("[Auth] loadAccount error", err?.code || err?.message, err);
            }

            if (!user || user.courts.length === 0) {
                showToast("⚠️", user
                    ? "No courts are assigned to this account yet."
                    : "This account isn't linked to an organisation yet.");
                signOut(auth);
                return;
            }

            loggedInUser = user;
            scoreboard.user = user;
            scoreboard.updateAvailableChannels();
            scoreboard.startDataSync();
            $('#auth').hide();
            $userString.text(user.displayName);
            $('header #user_email').text(user.email);
            $('header #admin_tag').toggle(user.isAdmin);
            $logoutButton.text('Logout');
            if (signedInViaForm) showToast("✅", `Signed in as ${user.displayName}`, 2000);
            if (AUTH_DEBUG) console.log("[Auth] eingeloggt:", user.orgId, user.isAdmin ? "(admin)" : "", user.channels);
            resolve(user);
        });
    });
}

/** Max. Wartezeit für Firebase Auth (danach Abbruch mit Timeout-Meldung). */
const AUTH_TIMEOUT_MS = 10_000;

function withTimeout(promise, ms, timeoutMessage = 'Zeitüberschreitung') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error(timeoutMessage), { code: 'auth/timeout' })), ms)
        )
    ]);
}

/**
 * Sign in via Firebase Auth (email + password). Returns true if signing in
 * worked - onAuthStateChanged takes care of the rest.
 */
async function login(email, password) {
    if (!email.includes('@')) {
        showToast("❌", "Please sign in with your email address.");
        return false;
    }

    if (AUTH_DEBUG) console.log("[Auth] login: signInWithEmailAndPassword start, email=" + email);
    try {
        await withTimeout(
            signInWithEmailAndPassword(auth, email, password),
            AUTH_TIMEOUT_MS,
            'Sign-in is taking too long.'
        );
        return true;
    } catch (err) {
        if (AUTH_DEBUG) console.warn("[Auth] login: signInWithEmailAndPassword error", err?.code, err?.message);
        if (err.code === 'auth/timeout') {
            showToast("⏱️", "Sign-in is taking too long. Please try again.");
        } else if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
            showToast("❌", "Wrong email or password. Please try again.");
        } else {
            showToast("❌", err.message || "Sign-in failed.");
        }
        return false;
    }
}

export function showToast(emoji, message, duration) {
    try {
        // Set the animation-duration of the cooldown ring to the show duration
        const showDuration = duration || 5000;
        $banner.find('.icon').html(emoji);
        $banner.find('.progress-ring_circle').css('animation-duration', `${showDuration / 1000}s`);
        $banner.find('p').html(message);
        $banner.fadeIn(100);
        
        // Fade out banner after the set show duration if not already closed manually
        setTimeout(() => {
            $banner.fadeOut(100);
        }, showDuration);
    } catch (error) {
        console.log("Banner shown: " + message);
    }
}

// ========================================= Helper Functions ===================================== //

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
