#!/usr/bin/env node
/**
 * Migrates an RTDB export from the old `users` model (username -> account_mail
 * + channel list) to the org/court model from database.rules.json:
 *
 *   orgs/<org>       { name, channels: { <channel>: <court> } }   public
 *   accounts/<uid>   { org, role: "operator" | "admin", email }   the account itself, admins
 *
 * Every old user becomes an org (same ID, display_name as its name), and its
 * channels become courts 1..n in ascending order. The match-<n> data stays
 * unchanged, as does the old `users` node, so the previous app keeps working
 * until the deploy - it is deleted afterwards (see README).
 *
 * UIDs are listed in the Firebase Console under Authentication -> Users.
 *
 * Usage:
 *   node scripts/migrate-to-orgs.mjs <export.json> <uids.json> <out.json>
 *        [--admin <email>]...            give the account the "admin" role
 *        [--member <email>=<org>]...     additional account for an org
 *        [--org-name <org>=<Name>]...    override an org's display name
 *
 * uids.json: { "<account_mail>": "<uid>", ... }
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const adminEmails = [];
const extraMembers = [];
const orgNames = {};
const positional = [];
const splitPair = (arg) => {
    const i = arg.indexOf('=');
    return [arg.slice(0, i), arg.slice(i + 1)];
};
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--admin') adminEmails.push(args[++i]);
    else if (args[i] === '--member') extraMembers.push(splitPair(args[++i]));
    else if (args[i] === '--org-name') {
        const [org, name] = splitPair(args[++i]);
        orgNames[org] = name;
    } else positional.push(args[i]);
}
const [exportPath, uidsPath, outPath] = positional;
if (!exportPath || !uidsPath || !outPath) {
    console.error('Usage: node scripts/migrate-to-orgs.mjs <export.json> <uids.json> <out.json> [--admin <email>] [--member <email>=<org>] [--org-name <org>=<Name>]');
    process.exit(1);
}

const data = JSON.parse(readFileSync(exportPath, 'utf8'));
const uids = JSON.parse(readFileSync(uidsPath, 'utf8'));
const users = data.users || {};

const orgs = {};
const accounts = {};
const ownerOf = {}; // channel -> org, only to catch a channel assigned twice
const missing = [];

const uidFor = (email) => {
    const uid = uids[email.trim()];
    if (!uid) missing.push(email);
    return uid;
};

// email is only a label so accounts are recognisable in the console;
// sign-in itself goes through Firebase Auth.
const addAccount = (email, orgId) => {
    const uid = uidFor(email);
    if (uid) accounts[uid] = { org: orgId, role: 'operator', email: email.trim() };
};

for (const [orgId, user] of Object.entries(users)) {
    const channelList = String(user.channels || '')
        .split(',')
        .map((c) => parseInt(c, 10))
        .filter((c) => !Number.isNaN(c))
        .sort((a, b) => a - b);

    const channels = {};
    channelList.forEach((channel, i) => {
        if (ownerOf[channel]) {
            throw new Error(`match-${channel} is assigned to both "${ownerOf[channel]}" and "${orgId}"`);
        }
        ownerOf[channel] = orgId;
        channels[channel] = i + 1;
    });
    orgs[orgId] = { name: orgNames[orgId] || user.display_name || orgId, channels };

    if (user.account_mail) addAccount(user.account_mail, orgId);
}

for (const [email, orgId] of extraMembers) {
    if (!orgs[orgId]) throw new Error(`--member ${email}: unknown org "${orgId}"`);
    addAccount(email, orgId);
}

for (const email of adminEmails) {
    const uid = uidFor(email);
    if (uid) accounts[uid] = { org: accounts[uid]?.org ?? null, role: 'admin', email: email.trim() };
}

if (missing.length) {
    console.error('Missing UIDs for:\n  ' + missing.join('\n  '));
    process.exit(1);
}

// New nodes first, followed by all existing data unchanged.
const out = { orgs, accounts, ...data };
writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

console.log(`Wrote ${outPath}`);
for (const [orgId, org] of Object.entries(orgs)) {
    const list = Object.entries(org.channels).map(([ch, court]) => `${court}=match-${ch}`).join(', ');
    const members = Object.values(accounts).filter((a) => a.org === orgId);
    const admins = members.filter((a) => a.role === 'admin').length;
    console.log(`  ${orgId.padEnd(16)} ${org.name} (${members.length} account${members.length === 1 ? '' : 's'}${admins ? `, ${admins} admin` : ''}): ${list}`);
}
const unowned = Object.keys(data)
    .filter((k) => /^match-\d+$/.test(k) && !ownerOf[k.slice(6)])
    .join(', ');
if (unowned) console.log(`  Not assigned to any org (admins only): ${unowned}`);
