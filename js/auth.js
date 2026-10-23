// Sign-in and account (org, role, courts), shared by every page: the input
// panel, the overview (index.html) and the spectator view (display.html).
// Firebase Auth keeps the session per site, so signing in on one page signs
// in on all of them. No jQuery, no DOM.

import { get, ref } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db, auth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "./firebase_config.js?v=4";
import { User } from "./User.js?v=4";

// Every org (federation/organiser) operates its own courts 1..n. Data is still
// stored under match-<channel>, so LED boards and bridges don't need to know
// about any of this - the mapping lives in orgs/<org>/channels/<channel> = <court>.
// Structure and read access: see database.rules.json.

/**
 * Courts of an org as [{ org, orgName, court, channel }], sorted by court.
 * Firebase sometimes returns objects with numeric keys as a sparse array
 * (index = channel) - Object.entries plus the null filter covers both.
 */
export function courtsOfOrg(orgId, org) {
    return Object.entries(org?.channels || {})
        .filter(([, court]) => court != null)
        .map(([channel, court]) => ({ org: orgId, orgName: org.name || orgId, court: Number(court), channel: Number(channel) }))
        .sort((a, b) => a.court - b.court);
}

/** Internal channel number for a court of an org, or null. */
export async function resolveCourt(orgId, court) {
    if (!/^[\w-]+$/.test(orgId) || !/^\d+$/.test(court)) return null;
    try {
        const snap = await get(ref(db, `orgs/${orgId}`));
        const match = courtsOfOrg(orgId, snap.val()).find((c) => c.court === Number(court));
        return match ? match.channel : null;
    } catch (err) {
        console.warn("[Auth] resolveCourt error", orgId, court, err?.code || err?.message);
        return null;
    }
}

/**
 * Loads org, role and courts of the signed-in Firebase user. Admins get the
 * courts of all orgs (their own first). Returns null if the account has no
 * entry, or neither an org nor the admin role.
 */
export async function loadAccount(firebaseUser) {
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

/**
 * Calls onChange on every sign-in state change: (user) with a User, or
 * (null, reason) - reason 'signed-out', 'no-org' (account not linked to an org)
 * or 'error' (couldn't be loaded). The first call comes once Firebase knows
 * whether a session from an earlier visit is still valid.
 * @returns {Function} unsubscribe
 */
export function watchAccount(onChange) {
    return onAuthStateChanged(auth, async (firebaseUser) => {
        if (!firebaseUser) {
            onChange(null, 'signed-out');
            return;
        }
        let user = null;
        try {
            user = await loadAccount(firebaseUser);
        } catch (err) {
            console.error("[Auth] loadAccount error", err?.code || err?.message, err);
            onChange(null, 'error');
            return;
        }
        onChange(user, user ? null : 'no-org');
    });
}

/** Max. wait for Firebase Auth (then aborted with a timeout message). */
const AUTH_TIMEOUT_MS = 10_000;

export function withTimeout(promise, ms, timeoutMessage = 'Timeout') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(Object.assign(new Error(timeoutMessage), { code: 'auth/timeout' })), ms)
        )
    ]);
}

/**
 * Sign in via Firebase Auth (email + password). Resolves to null on success
 * (watchAccount() takes over from there) or to a message to show.
 */
export async function login(email, password) {
    if (!String(email).includes('@')) return "Please sign in with your email address.";
    try {
        await withTimeout(signInWithEmailAndPassword(auth, email, password), AUTH_TIMEOUT_MS, 'Sign-in is taking too long.');
        return null;
    } catch (err) {
        if (err.code === 'auth/timeout') return "Sign-in is taking too long. Please try again.";
        if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(err.code)) {
            return "Wrong email or password. Please try again.";
        }
        return err.message || "Sign-in failed.";
    }
}

export function logout() {
    return signOut(auth);
}
