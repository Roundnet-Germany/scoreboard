// import firebase config
import { get, ref, update, set, remove, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.5.2/firebase-database.js";
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
        'brand_logo': 'img/irf_logo_white.png'
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
/** Wird beim Form-Login gesetzt, damit onAuthStateChanged nicht doppelt startDataSync() auslöst. */
let loginInProgressFromForm = false;

// =========================================== Page Load ======================================= //

$(document).ready(async function () {
    $banner = $('.banner');
    $logoutButton = $('button#logout');
    $userString = $('header #username');

    // Get URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const urlChannel = urlParams.get('channel');
    const urlTheme = urlParams.get('theme');
    
    // Parse channel selection with fallback
    const channelSelection = isNaN(parseInt(urlChannel, 10)) ? 1 : urlChannel;
    const themeSelection = urlTheme;

    // Determine board type
    const type = $('html').attr('type') === 'output' ? 'output' : 'input';

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

export async function readData(channel) {
    if (AUTH_DEBUG) console.log("[Data] readData start, channel:", channel);
    try {
        const matchRef = ref(db, `match-${channel}`);
        const matchData = await get(matchRef);
        if (AUTH_DEBUG) console.log("[Data] readData ok, channel:", channel);
        return matchData.val();
    } catch (err) {
        if (AUTH_DEBUG) console.warn("[Data] readData error, channel:", channel, err?.code || err?.message, err);
        throw err;
    }
}

// Kurzer Cache für users – vermeidet mehrfache langsame Reads und nutzt Preload
const USERS_CACHE_TTL_MS = 60_000; // 1 Minute
let _usersCache = { data: null, timestamp: 0 };

async function getUsers(useCache = true) {
    const now = Date.now();
    if (useCache && _usersCache.data !== null && now - _usersCache.timestamp < USERS_CACHE_TTL_MS) {
        if (AUTH_DEBUG) console.log("[Auth] getUsers aus Cache");
        return _usersCache.data;
    }
    if (AUTH_DEBUG) console.log("[Auth] getUsers start (Netzwerk)");
    const usersData = await get(ref(db, 'users'));
    const val = usersData.val();
    _usersCache = { data: val, timestamp: Date.now() };
    if (AUTH_DEBUG) console.log("[Auth] getUsers ok");
    return val;
}

/** Users im Hintergrund laden (z. B. wenn Login-Formular erscheint), damit der erste echte getUsers() schnell ist. */
function preloadUsers() {
    getUsers(false).catch(() => {});
}

export async function writeData(newData) {
    try {
        await update(ref(db), newData);
        console.log("Data updated successfully.");
    } catch (error) {
        console.error("Error updating user data:", error);
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
    }
}

// ========================================= Global Functions ===================================== //

async function handleAuthentication(scoreboard) {
    preloadUsers(); // Sofort starten, damit getUsers() später oft aus dem Cache kommt
    return new Promise((resolve) => {
        onAuthStateChanged(auth, async (firebaseUser) => {
            if (AUTH_DEBUG) console.log("[Auth] onAuthStateChanged", firebaseUser ? "user=" + firebaseUser.email : "user=null", "loginInProgressFromForm=" + loginInProgressFromForm);

            if (firebaseUser) {
                // Wenn gerade Form-Login läuft: UI-Update und startDataSync macht der Form-Handler (vermeidet Race + doppelte Aufrufe)
                if (loginInProgressFromForm) {
                    if (AUTH_DEBUG) console.log("[Auth] onAuthStateChanged: skip (Form-Login übernimmt)");
                    return;
                }
                if (AUTH_DEBUG) console.log("[Auth] onAuthStateChanged: Session vorhanden, lade User-Daten…");
                const users = await getUsers();
                const dbUser = findUserByAccountMail(users, firebaseUser.email);
                if (dbUser) {
                    const authChannels = typeof dbUser.channels === 'string'
                        ? dbUser.channels.split(',') : dbUser.channels;
                    loggedInUser = new User(dbUser.key, authChannels, dbUser.display_name);
                    scoreboard.user = loggedInUser;
                    scoreboard.updateAvailableChannels();
                    scoreboard.startDataSync();
                    $('#auth').hide();
                    $userString.html(dbUser.display_name);
                    $logoutButton.html('Logout');
                    if (AUTH_DEBUG) console.log("[Auth] onAuthStateChanged: eingeloggt (Session), startDataSync aufgerufen");
                    resolve(loggedInUser);
                } else {
                    showToast("⚠️", "No account found for this email.");
                    signOut(auth);
                }
            } else {
                loggedInUser = null;
                loginInProgressFromForm = false;
                $('#auth').show();
                preloadUsers(); // Users im Hintergrund laden, damit getUsers() beim Klick auf Login oft aus dem Cache kommt
                if (AUTH_DEBUG) console.log("[Auth] onAuthStateChanged: kein User, Login-Formular angezeigt");

                $('form#login').off('submit').on('submit', async function (e) {
                    e.preventDefault();
                    const $submitBtn = $('#auth #submit');
                    const originalText = $submitBtn.text();
                    $submitBtn.prop('disabled', true).addClass('is-loading').text('Signing in…');
                    loginInProgressFromForm = true;
                    if (AUTH_DEBUG) console.log("[Auth] Form Submit: Login start…");

                    try {
                        const usernameOrEmail = $('#auth #username').val().trim();
                        const password = $('#auth #password').val();
                        loggedInUser = await login(usernameOrEmail, password);

                        if (loggedInUser) {
                            $('#auth').hide();
                            scoreboard.user = loggedInUser;
                            scoreboard.updateAvailableChannels();
                            scoreboard.startDataSync();
                            $userString.html(loggedInUser.displayName);
                            $logoutButton.html('Logout');
                            if (AUTH_DEBUG) console.log("[Auth] Form Submit: Login OK, startDataSync aufgerufen");
                            showToast("✅", `Signed in as ${loggedInUser.displayName}`, 2000);
                            resolve(loggedInUser);
                        }
                    } finally {
                        loginInProgressFromForm = false;
                        $submitBtn.prop('disabled', false).removeClass('is-loading').text(originalText);
                        if (AUTH_DEBUG) console.log("[Auth] Form Submit: Ende (loginInProgressFromForm=false)");
                    }
                });
            }
        });
    });
}

/** Findet den DB-User anhand der Firebase-Auth-E-Mail (account_mail). */
function findUserByAccountMail(users, email) {
    if (!users || !email) return null;
    for (const [key, val] of Object.entries(users)) {
        if (val.account_mail === email)
            return {
                key,
                channels: val.channels,
                display_name: val.display_name || key
            };
    }
    return null;
}

async function signUp(email, password) {
    const users = await getUsers();
    if (users && users[email]) {
        showToast("❌", "Username already exists");
        return null;
    }

    try {
        await set(ref(db, `users/${email}`), {
            email: email,
            password: password // Store password (not hashed)
        });
        console.log(`User ${email} registered.`);
    } catch (error) {
        console.error("Error during registration:", error);
        showToast("⚠️", "Registration failed: " + error.message);
        throw error;
    }
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
 * Login per Firebase Auth (E-Mail + Passwort).
 * usernameOrEmail: E-Mail oder Username (DB-Key); bei Username wird account_mail aus der DB verwendet.
 */
async function login(usernameOrEmail, password) {
    const users = await getUsers();
    let email;

    if (usernameOrEmail.includes('@')) {
        email = usernameOrEmail.trim();
    } else {
        const dbEntry = users && users[usernameOrEmail];
        if (!dbEntry || !dbEntry.account_mail) {
            showToast("❌", "User not found. Try your email address instead.");
            return null;
        }
        email = dbEntry.account_mail.trim();
    }

    if (AUTH_DEBUG) console.log("[Auth] login: signInWithEmailAndPassword start, email=" + email);
    try {
        await withTimeout(
            signInWithEmailAndPassword(auth, email, password),
            AUTH_TIMEOUT_MS,
            'Sign-in is taking too long.'
        );
        if (AUTH_DEBUG) console.log("[Auth] login: signInWithEmailAndPassword ok");
    } catch (err) {
        if (AUTH_DEBUG) console.warn("[Auth] login: signInWithEmailAndPassword error", err?.code, err?.message);
        if (err.code === 'auth/timeout') {
            showToast("⏱️", "Sign-in is taking too long. Please try again.");
        } else if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
            showToast("❌", "Wrong email or password. Please try again.");
        } else {
            showToast("❌", err.message || "Sign-in failed.");
        }
        return null;
    }

    const dbUser = findUserByAccountMail(users, email);
    if (!dbUser) {
        showToast("⚠️", "No account found for this email.");
        signOut(auth);
        return null;
    }

    const authChannels = typeof dbUser.channels === 'string' ? dbUser.channels.split(',') : dbUser.channels;
    return new User(dbUser.key, authChannels, dbUser.display_name);
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

function isNumeric(value) {
    return /^-?\d+$/.test(value);
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
