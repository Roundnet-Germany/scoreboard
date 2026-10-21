// Live overview (index.html, the start page): every court of every org at a glance.
//
// Read-only and public, like the output displays: it reads orgs (which courts
// exist), live_games (when a Playerzone game went on court) and the parts of
// each match-<channel> a card needs - never event_history, which can hold up
// to 1000 events per court. What counts as "running" is decided by
// summarizeMatch() in matchStatus.js from updated_at, the score and the set mode.

import { ref, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { db } from "./firebase_config.js?v=4";
import { summarizeMatch } from "./matchStatus.js?v=4";
import { resolveFlag } from "./flags.js?v=4";
import { pzGamePage } from "./pzBase.js?v=4";
import { groupSquadGames } from "./squadGroups.js?v=4";
import { watchAccount, login, logout } from "./auth.js?v=4";
import { showToast } from "./toast.js?v=4";

/** The parts of match-<channel> the overview reads, one listener each. */
const MATCH_FIELDS = ['score', 'active_set', 'teams_info', 'tournament_name', 'phase', 'game_settings', 'updated_at', 'timer', 'playerzone', 'admin_settings', 'tournament_logo'];

/** Open/closed state of the collapsible sections, remembered per browser. */
const COLLAPSED_KEY = 'overview_collapsed';
/** Sections that start collapsed until the viewer opens them. */
const COLLAPSED_BY_DEFAULT = ['idle'];

const STATUS_LABELS = { live: 'Live', ready: 'Not started', finished: 'Finished', idle: 'Inactive' };

// ========================================= State ===================================== //

let orgs = {};
let liveGames = {};
/** channel -> { data: {field: value}, unsubscribe: [fn] } */
const matches = new Map();
/** Server time minus local time, so "x min ago" and timers match every other reader. */
let serverTimeOffset = 0;
let orgsLoaded = false;

const urlParams = new URLSearchParams(window.location.search);
const filters = {
    org: urlParams.get('org') || '',
    query: '',
};
const collapsed = readCollapsed();
/** Signed-in account (auth.js) - decides which courts get the input panel and output links. */
let account = null;
let orgFilterFromAccount = false;

// ========================================= Data ===================================== //

/**
 * Every court as { channel, org, orgName, court }. Firebase sometimes returns
 * objects with numeric keys as a sparse array (index = channel) - Object.entries
 * plus the null filter covers both. Channels only known from live_games (not
 * mapped to any org) still show up, labelled by their channel.
 */
function allCourts() {
    const courts = new Map();
    for (const [orgId, org] of Object.entries(orgs || {})) {
        for (const [channel, court] of Object.entries(org?.channels || {})) {
            if (court == null) continue;
            courts.set(Number(channel), { channel: Number(channel), org: orgId, orgName: org.name || orgId, court: Number(court) });
        }
    }
    for (const entry of Object.values(liveGames || {})) {
        const channel = Number(entry?.channel);
        if (channel && !courts.has(channel)) courts.set(channel, { channel, org: null, orgName: '', court: null });
    }
    return courts;
}

/** Subscribes to every court's match and drops listeners of courts that are gone. */
function syncSubscriptions() {
    const courts = allCourts();
    for (const channel of courts.keys()) {
        if (matches.has(channel)) continue;
        const entry = { data: {}, unsubscribe: [] };
        matches.set(channel, entry);
        for (const field of MATCH_FIELDS) {
            entry.unsubscribe.push(onValue(ref(db, `match-${channel}/${field}`), (snapshot) => {
                entry.data[field] = snapshot.val();
                scheduleRender();
            }, (err) => console.warn(`[Overview] match-${channel}/${field}:`, err?.code || err?.message)));
        }
    }
    for (const [channel, entry] of matches) {
        if (courts.has(channel)) continue;
        entry.unsubscribe.forEach((unsubscribe) => unsubscribe());
        matches.delete(channel);
    }
}

function startDataSync() {
    onValue(ref(db, '.info/serverTimeOffset'), (snapshot) => {
        serverTimeOffset = Number(snapshot.val()) || 0;
    });
    onValue(ref(db, 'orgs'), (snapshot) => {
        orgs = snapshot.val() || {};
        orgsLoaded = true;
        renderOrgFilter();
        syncSubscriptions();
        scheduleRender();
    }, (err) => {
        console.error('[Overview] reading orgs failed', err);
        $('#overview_error').text("Couldn't load the courts - please reload the page.").removeClass('hidden');
    });
    onValue(ref(db, 'live_games'), (snapshot) => {
        liveGames = snapshot.val() || {};
        syncSubscriptions();
        scheduleRender();
    });
}

// ========================================= View model ===================================== //

const now = () => Date.now() + serverTimeOffset;

/** Stream theme of the signed-in account's org - set as orgs/<org>/theme in the console. */
function streamTheme() {
    const theme = account?.orgId ? orgs[account.orgId]?.theme : null;
    return typeof theme === 'string' && /^[\w-]+$/.test(theme) ? theme : 'rg';
}

/**
 * Colors, flags and player names follow the court's own display settings
 * (admin_settings), with the input panel's defaults: colors and names on,
 * flags off - and flags replace the colors, like on the boards.
 */
function displaySettings(adminSettings) {
    const on = (key, fallback) => (adminSettings?.[key] == null ? fallback : Number(adminSettings[key]) === 1);
    // Team indicator (one of color / flag / club logos / team logo) - logos
    // win over the rest, flags over colors, like on the boards
    const logoMode = on('show_club_logo', false) ? 'club' : on('show_team_logo', false) ? 'team' : null;
    const showFlag = on('show_flag', false) && !logoMode;
    return {
        logoMode,
        showFlag,
        showColor: on('show_color', true) && !showFlag && !logoMode,
        showPlayers: on('show_player_names', true),
        showSquad: on('show_group_score', false),
    };
}

function teamView(teamsInfo, team, fallback, display) {
    const info = teamsInfo?.[`team_${team}`] || {};
    const name = String(info.name || '').trim() || fallback;
    const explicitFlag = String(info.flag || '').trim();
    const flag = !display.showFlag ? ''
        : /^[A-Za-z]{2}$/.test(explicitFlag) ? explicitFlag.toLowerCase() : resolveFlag(info.name || '').toLowerCase();
    const players = display.showPlayers ? [info.player_1, info.player_2].map((p) => String(p || '').trim()).filter(Boolean) : [];
    const color = display.showColor && /^#[0-9a-f]{6}$/i.test(info.color || '') ? info.color : null;
    // Club logos: one per club (one when both play for the same club), team logo: teams_info.team_x.logo.
    // Only http(s) images - the URLs come from match data
    const urls = display.logoMode === 'club' ? [info.player_1_club_logo, info.player_2_club_logo]
        : display.logoMode === 'team' ? [info.logo] : [];
    const logos = [...new Set(urls.map((url) => String(url || '').trim()).filter((url) => /^https?:\/\/\S+$/i.test(url)))];
    return { name, flag, players: players.join(' / '), color, logos, logoMode: display.logoMode };
}

function formatAge(ms) {
    if (ms == null) return 'No activity recorded';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return 'Updated just now';
    if (minutes < 60) return `Updated ${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Last activity ${hours} h ago`;
    const days = Math.floor(hours / 24);
    return `Last activity ${days} day${days === 1 ? '' : 's'} ago`;
}

function formatCountdown(ms) {
    const seconds = Math.ceil(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatClock(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Everything a card shows, as plain data - a card is only rebuilt when this changes. */
function cardView(court) {
    const data = matches.get(court.channel)?.data || {};
    const summary = summarizeMatch(data, now());
    const display = displaySettings(data.admin_settings);
    const teamA = teamView(data.teams_info, 'a', 'Team A', display);
    const teamB = teamView(data.teams_info, 'b', 'Team B', display);
    const situation = [];
    if (summary.status !== 'idle' && summary.timer) {
        situation.push({ kind: 'timer', text: `${summary.timer.label} ${formatCountdown(summary.timer.remainingMs)}` });
    }

    const gameId = Number(data.playerzone?.game_id) || null;
    const mainGameId = Number(data.playerzone?.main_game_id) || null;
    const liveEntry = gameId ? liveGames?.[gameId] : null;
    const since = liveEntry && Number(liveEntry.channel) === court.channel ? Number(liveEntry.since) || null : null;

    const courtParams = court.org
        ? `org=${encodeURIComponent(court.org)}&court=${court.court}`
        : `channel=${court.channel}`;

    const courtLabel = court.court != null ? `Court ${court.court}` : `Channel ${court.channel}`;
    const phase = String(data.phase || '').trim();

    return {
        channel: court.channel,
        courtNumber: court.court ?? court.channel,
        org: court.org,
        orgName: court.orgName,
        // The game title leads; the court moves down next to the org
        title: phase || courtLabel,
        event: String(data.tournament_name || '').trim(),
        // Only http(s) images - the URL comes from match data anyone with write access to the court sets
        eventLogo: /^https?:\/\/\S+$/i.test(String(data.tournament_logo || '').trim()) ? String(data.tournament_logo).trim() : null,
        location: [court.orgName, phase ? courtLabel : null].filter(Boolean).join(' · '),
        status: summary.status,
        teams: { a: teamA, b: teamB },
        sets: summary.sets,
        winner: summary.winner,
        serve: summary.status === 'live' || summary.status === 'ready' ? summary.serve : null,
        squad: display.showSquad ? summary.squad : null,
        situation,
        age: summary.status === 'idle' && !summary.updatedAt && !summary.hasPoints ? 'No activity recorded' : formatAge(summary.age),
        since: since && summary.status !== 'idle' ? `On court since ${formatClock(since)}` : '',
        pzLink: gameId ? pzGamePage(gameId) : null,
        pzGameId: gameId,
        mainGameId,
        // Everyone: the big spectator view. Accounts that operate the court: input panel and display output
        spectatorLink: `display.html?${courtParams}&theme=spectator`,
        canControl: !!account?.channels.includes(court.channel),
        // Stream overlay for OBS, in the theme of the signed-in account's org (orgs/<org>/theme, default rg)
        streamLink: new URL(`display.html?${courtParams}&theme=${encodeURIComponent(streamTheme())}`, window.location.href).href,
        controlLink: `input.html?${courtParams}`,
        searchText: [court.orgName, courtLabel, data.tournament_name, phase,
            teamA.name, teamA.players, teamB.name, teamB.players].join(' ').toLowerCase(),
    };
}

// ========================================= Rendering ===================================== //

/** Small DOM helper - text is always set as text, never parsed as HTML (team names come from outside). */
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'style') Object.assign(node.style, value);
        else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
        if (child != null && child !== false) node.append(child);
    }
    return node;
}

const icon = (name) => el('i', { class: 'material-symbols-rounded', 'aria-hidden': 'true', text: name });

/** Flag or logos next to a team name - a logo that doesn't load is dropped. */
function teamIndicator(info) {
    if (info.logos?.length) {
        return el('span', { class: 'team_logos' }, info.logos.map((src) => {
            const img = el('img', { src, alt: '', loading: 'lazy' });
            img.addEventListener('error', () => img.remove(), { once: true });
            return img;
        }));
    }
    if (info.flag) return el('img', { class: 'team_flag', src: `https://flagcdn.com/${info.flag}.svg`, alt: info.flag.toUpperCase(), loading: 'lazy' });
    return null;
}

function teamRow(view, team) {
    const info = view.teams[team];
    const isWinner = view.winner === team;
    return el('div', { class: `team_row${isWinner ? ' winner' : ''}` },
        info.color ? el('span', { class: 'team_color', style: { backgroundColor: info.color } }) : null,
        el('div', { class: 'team_info' },
            el('div', { class: 'team_name_row' },
                teamIndicator(info),
                el('span', { class: 'team_name', text: info.name, title: info.name }),
            ),
            info.players ? el('span', { class: 'team_players', text: info.players, title: info.players }) : null,
        ),
        serveIndicator(view.serve, team),
        // Squad score of a liga game, where the court shows it (Group Score setting)
        view.squad ? el('span', {
            class: `squad_score${view.squad[team] > view.squad[team === 'a' ? 'b' : 'a'] ? ' leading'
                : view.squad[team] < view.squad[team === 'a' ? 'b' : 'a'] ? ' trailing' : ''}`,
            title: 'Squad score', text: view.squad[team],
        }) : null,
        view.sets.map((set) => {
            const own = set[team];
            const classes = ['set_score'];
            if (set.active && !set.winner && view.status !== 'idle') classes.push('active');
            if (set.winner === team) classes.push('set_won');
            else if (set.winner) classes.push('set_lost');
            return el('span', { class: classes.join(' '), title: `Set ${set.set}`, text: own });
        }),
    );
}

/**
 * The rg theme's serve indicator: dots stacked vertically, one per serve
 * left - two on the 1st serve, the upper one used up on the 2nd, a single
 * dot for a single serve.
 */
function serveIndicator(serve, team) {
    if (!serve) return null;
    if (serve.team !== team) return el('span', { class: 'serve' });
    const label = serve.single ? 'Serving' : `Serving (${serve.serveNumber === 1 ? '1st' : '2nd'} serve)`;
    const dots = serve.single ? ['left'] : [serve.serveNumber === 1 ? 'left' : 'used', 'left'];
    return el('span', { class: 'serve active', title: label, 'aria-label': label },
        dots.map((state) => el('span', { class: `serve_dot ${state}` })));
}

/** A logo that doesn't load leaves no gap behind. */
function eventLogo(src) {
    const img = el('img', { class: 'event_logo', src, alt: '' });
    img.addEventListener('error', () => img.remove(), { once: true });
    return img;
}

/** Card title row: the event's logo (tournament_logo) first when there is one, then the title and the event name. */
function cardTitle(title, event, logo) {
    return el('div', { class: 'card_title' },
        logo ? eventLogo(logo) : null,
        el('span', { class: 'game_title', text: title, title }),
        event ? el('span', { class: 'event_label', text: event, title: event }) : null);
}

function buildCard(view, extraClass = '') {
    const status = el('span', { class: `status_badge ${view.status}` },
        view.status === 'live' ? el('span', { class: 'live_dot' }) : null,
        STATUS_LABELS[view.status]);

    // Situation tags (timeout, break, ...) sit left of the status tag, so they don't need a row of their own
    const situation = view.situation.map((chip) => el('span', { class: `chip ${chip.kind}` },
        chip.kind === 'timer' ? icon('timer') : null, chip.text));

    // Fixed order on every card: Playerzone, edit, stream link, open
    const links = el('div', { class: 'card_links' },
        view.pzLink ? el('a', {
            class: 'link icon_only pz', href: view.pzLink, target: '_blank', rel: 'noopener',
            title: `Open game ${view.pzGameId} in the Playerzone`, 'aria-label': 'Open in the Playerzone',
        }, el('img', { src: 'img/pz_logo.png', alt: '' })) : null,
        view.canControl ? el('a', { class: 'link icon_only control', href: view.controlLink, title: 'Open in the input panel', 'aria-label': 'Open in the input panel' }, icon('edit')) : null,
        view.canControl ? el('button', { type: 'button', class: 'link icon_only copy_stream', 'data-link': view.streamLink, title: 'Copy the stream link (OBS)', 'aria-label': 'Copy the stream link' }, icon('cast')) : null,
        el('a', { class: 'link icon_only open', href: view.spectatorLink, title: 'Open the scoreboard', 'aria-label': 'Open the scoreboard' }, icon('open_in_full')),
    );

    // The whole card opens the scoreboard (the links in it keep their own targets)
    return el('article', { class: `match_card ${view.status}${extraClass}`, 'data-channel': view.channel, 'data-href': view.spectatorLink },
        el('header', { class: 'card_head' },
            cardTitle(view.title, view.event, view.eventLogo),
            el('div', { class: 'card_tags' }, situation, status)),
        view.location ? el('div', { class: 'card_meta', text: view.location, title: view.location }) : null,
        el('div', { class: 'score_table' }, teamRow(view, 'a'), teamRow(view, 'b')),
        el('footer', { class: 'card_foot' },
            el('span', { class: 'card_time', text: view.since || view.age, title: view.since ? view.age : null }),
            links),
    );
}

// ----------------------------------- Squad games ----------------------------------- //

const swapTeam = (team) => (team === 'a' ? 'b' : team === 'b' ? 'a' : team);

/** A court's view with team A and B swapped - for a subgame whose sides are the other way round. */
function flipView(view) {
    return {
        ...view,
        teams: { a: view.teams.b, b: view.teams.a },
        sets: view.sets.map((set) => ({ ...set, a: set.b, b: set.a, winner: swapTeam(set.winner) })),
        winner: swapTeam(view.winner),
        serve: view.serve && { ...view.serve, team: swapTeam(view.serve.team) },
    };
}

/**
 * A subgame inside its squad block: the squads are named in the block's head,
 * so the rows show the pairing instead (players, or the name without them),
 * in the block's sides. The court's own squad score gives way to the computed one,
 * and event name and logo are already in the block's head.
 */
function subgameView(view, flipped) {
    const shown = flipped ? flipView(view) : view;
    const asPairing = (info) => ({ ...info, name: info.players || info.name, players: '' });
    return { ...shown, event: '', eventLogo: null, squad: null, teams: { a: asPairing(shown.teams.a), b: asPairing(shown.teams.b) } };
}

function squadTeam(info, name, side) {
    return el('div', { class: `squad_team ${side}` },
        info.color ? el('span', { class: 'team_color', style: { backgroundColor: info.color } }) : null,
        // Club logos belong to the players of one subgame, not to the squad
        teamIndicator(info.logoMode === 'club' ? { ...info, logos: [] } : info),
        el('span', { class: 'team_name', text: name, title: name }));
}

function buildSquad(entry) {
    const first = entry.members[0];
    const reference = first.flipped ? flipView(first.view) : first.view;
    const event = entry.members.map(({ view }) => view.event).find(Boolean) || '';
    const eventLogo = entry.members.map(({ view }) => view.eventLogo).find(Boolean) || null;
    const leader = entry.score.a === entry.score.b ? null : (entry.score.a > entry.score.b ? 'a' : 'b');
    const courts = entry.members.length;

    const status = el('span', { class: `status_badge ${entry.status}` },
        entry.status === 'live' ? el('span', { class: 'live_dot' }) : null,
        STATUS_LABELS[entry.status]);

    return el('article', { class: `squad_card ${entry.status}`, 'data-main-game': entry.mainGameId },
        el('header', { class: 'card_head' },
            cardTitle('Squad game', event, eventLogo),
            status),
        el('div', { class: 'squad_board' },
            squadTeam(reference.teams.a, entry.teams.a, `a${leader === 'a' ? ' leading' : ''}`),
            el('div', { class: 'squad_result', title: 'Subgames won (counted from the courts)' },
                el('span', { class: leader ? (leader === 'a' ? 'leading' : 'trailing') : null, text: entry.score.a }),
                el('span', { class: 'separator', text: ':' }),
                el('span', { class: leader ? (leader === 'b' ? 'leading' : 'trailing') : null, text: entry.score.b })),
            squadTeam(reference.teams.b, entry.teams.b, `b${leader === 'b' ? ' leading' : ''}`)),
        el('div', { class: 'subgame_grid' },
            entry.members.map(({ view, flipped }) => buildCard(subgameView(view, flipped), ' subgame'))),
        el('footer', { class: 'card_foot' },
            el('span', { class: 'card_time', text: `${entry.decided} of ${courts} subgames on court decided` }),
            el('div', { class: 'card_links' },
                el('a', {
                    class: 'link icon_only pz', href: pzGamePage(entry.mainGameId), target: '_blank', rel: 'noopener',
                    title: `Open squad game ${entry.mainGameId} in the Playerzone`, 'aria-label': 'Open in the Playerzone',
                }, el('img', { src: 'img/pz_logo.png', alt: '' })))),
    );
}

/** entry key -> { signature, node } */
const renderedEntries = new Map();

/** The DOM node of a court or squad entry - only rebuilt when what it shows changed. */
function entryNode(entry) {
    const strip = ({ searchText, ...shown }) => shown;
    const shown = entry.type === 'court'
        ? strip(entry.view)
        : { ...entry, members: entry.members.map(({ view, flipped }) => ({ view: strip(view), flipped })) };
    const signature = JSON.stringify(shown);
    const existing = renderedEntries.get(entry.key);
    if (existing?.signature === signature) return existing.node;
    const node = entry.type === 'court' ? buildCard(entry.view) : buildSquad(entry);
    if (existing) existing.node.replaceWith(node);
    renderedEntries.set(entry.key, { signature, node });
    return node;
}

/** Puts nodes into a container in this order, touching the DOM only if it differs. */
function placeNodes($container, nodes) {
    const container = $container[0];
    const current = Array.from(container.children);
    if (current.length === nodes.length && current.every((node, i) => node === nodes[i])) return;
    container.replaceChildren(...nodes);
}

const SECTIONS = [
    { id: 'live', statuses: ['live', 'ready'] },
    { id: 'finished', statuses: ['finished'] },
    { id: 'idle', statuses: ['idle'] },
];
const STATUS_ORDER = { live: 0, ready: 1, finished: 2, idle: 3 };

let renderScheduled = false;
function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        render();
    });
}

function render() {
    const query = filters.query.trim().toLowerCase();
    const allViews = Array.from(allCourts().values()).map(cardView);
    const inOrg = (view) => !filters.org || view.org === filters.org;
    const views = allViews.filter(inOrg);

    // Summary over the org filter, before the search
    const counts = { live: 0, ready: 0, finished: 0, idle: 0 };
    for (const view of views) counts[view.status]++;
    renderSummary(counts, views.length);

    // Subgames of a squad game become one entry, placed by its most active
    // subgame. Grouped before the org filter and the search, so a squad always
    // shows all its subgames - also those on another org's courts - once one
    // of them matches
    const sorted = allViews.sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status]
        || (x.orgName || '~').localeCompare(y.orgName || '~')
        || (x.courtNumber - y.courtNumber));
    const entryViews = (entry) => (entry.type === 'court' ? [entry.view] : entry.members.map((member) => member.view));
    const visible = groupSquadGames(sorted)
        .filter((entry) => entryViews(entry).some(inOrg))
        .filter((entry) => !query || entryViews(entry).some((view) => view.searchText.includes(query)));
    const visibleKeys = new Set(visible.map((entry) => entry.key));
    for (const key of renderedEntries.keys()) {
        if (!visibleKeys.has(key)) renderedEntries.delete(key);
    }

    for (const section of SECTIONS) {
        const sectionEntries = visible.filter((entry) => section.statuses.includes(entry.status));
        const $section = $(`#section_${section.id}`);
        const courtCount = sectionEntries.reduce((sum, entry) => sum + entryViews(entry).length, 0);
        $section.find('.section_count').text(courtCount || '');
        // "On court" always shows (with its empty state), the others only when they have courts
        const hidden = section.id !== 'live' && sectionEntries.length === 0;
        const isCollapsed = section.id !== 'live' && collapsed.has(section.id);
        $section.toggleClass('hidden', hidden).toggleClass('collapsed', isCollapsed);
        $section.find('.section_toggle').attr('aria-expanded', String(!isCollapsed));
        placeNodes($section.find('.card_grid'), hidden || isCollapsed ? [] : sectionEntries.map(entryNode));
    }

    const liveCount = visible.filter((entry) => entry.status === 'live' || entry.status === 'ready').length;
    $('#section_live .empty_state')
        .toggleClass('hidden', !orgsLoaded || liveCount > 0)
        .text(query ? 'No running match matches your search.' : 'No matches running right now.');
    $('html').toggleClass('is-loading', !orgsLoaded);
}

function renderSummary(counts, total) {
    const items = [
        ['live', counts.live, 'Live'],
        ['ready', counts.ready, 'Not started'],
        ['finished', counts.finished, 'Just finished'],
    ];
    const nodes = items.map(([kind, value, label]) =>
        el('div', { class: `summary_item ${kind}${value ? '' : ' zero'}` },
            el('span', { class: 'summary_value', text: value }),
            el('span', { class: 'summary_label', text: label })));
    nodes.push(el('div', { class: 'summary_item courts' },
        el('span', { class: 'summary_value', text: total }),
        el('span', { class: 'summary_label', text: total === 1 ? 'Court' : 'Courts' })));
    const signature = JSON.stringify([counts, total]);
    const $summary = $('#summary');
    if ($summary.data('signature') === signature) return;
    $summary.data('signature', signature)[0].replaceChildren(...nodes);
}

function renderOrgFilter() {
    const $select = $('#org_filter');
    const options = Object.entries(orgs)
        .filter(([, org]) => Object.keys(org?.channels || {}).length > 0)
        .map(([id, org]) => ({ id, name: org?.name || id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    // An org from the URL that doesn't exist (anymore) - show everything instead
    if (filters.org && !options.some((o) => o.id === filters.org)) filters.org = '';
    $select[0].replaceChildren(
        el('option', { value: '', text: 'All organisations' }),
        ...options.map((o) => el('option', { value: o.id, text: o.name })));
    $select.val(filters.org);
    $select.closest('.filter').toggleClass('hidden', options.length < 2 && !filters.org);
    updateTitle();
}

/** The selected org is in the filter itself - only the browser tab names it. */
function updateTitle() {
    const orgName = filters.org ? (orgs[filters.org]?.name || filters.org) : '';
    document.title = orgName ? `Live Matches · ${orgName}` : 'Live Matches';
}

// ========================================= Controls ===================================== //

function readCollapsed() {
    try {
        const stored = JSON.parse(localStorage.getItem(COLLAPSED_KEY));
        if (Array.isArray(stored)) return new Set(stored);
    } catch { /* storage unavailable or broken - use the defaults */ }
    return new Set(COLLAPSED_BY_DEFAULT);
}

function storeCollapsed() {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* not remembered */ }
}

// ========================================= Account ===================================== //

function renderAccount() {
    const $account = $('#account');
    if (!account) {
        // On phones only the icon (the label goes, see style_overview.css)
        $account[0].replaceChildren(el('button', { type: 'button', class: 'account_login', id: 'open_login', 'aria-label': 'Log in', title: 'Log in' },
            icon('login'), el('span', { class: 'account_login_label', text: 'Log in' })));
        return;
    }
    // Same element as in the input panel's header: name, email, admin tag, logout
    $account[0].replaceChildren(el('div', { class: 'account_user' },
        el('div', { class: 'account_details' },
            el('span', { class: 'account_name', text: account.displayName }),
            el('span', { class: 'account_email', text: account.email })),
        account.isAdmin ? el('span', { class: 'account_tag', text: 'Admin' }) : null,
        el('button', { type: 'button', class: 'account_logout', id: 'logout', title: 'Log out', 'aria-label': 'Log out' }, icon('logout'))));
}

function bindAccount() {
    const dialog = document.getElementById('login_dialog');
    const $error = $('#login_error');

    // Opened non-modal with a backdrop of its own: a modal <dialog> makes the
    // rest of the page inert - password managers' fill menus (Bitwarden) sit
    // there and can't fill the fields then
    const openLogin = () => {
        if (dialog.open) return;
        dialog.show();
        $('html').addClass('login_open');
    };
    $(dialog).on('close', () => $('html').removeClass('login_open'));
    $('.login_backdrop').on('click', () => dialog.close());
    $(document).on('keydown', (event) => {
        if (event.key === 'Escape' && dialog.open) dialog.close();
    });

    $('#account').on('click', '#open_login', () => {
        $error.text('').addClass('hidden');
        openLogin();
        $('#login_email').trigger('focus');
    });
    $('#account').on('click', '#logout', async () => {
        await logout();
        showToast('👋', 'Logged out', 2000);
    });
    $('#login_cancel').on('click', () => dialog.close());

    $('#login_form').on('submit', async (event) => {
        event.preventDefault();
        const $submit = $('#login_submit').prop('disabled', true).text('Signing in…');
        const error = await login($('#login_email').val().trim(), $('#login_password').val());
        $submit.prop('disabled', false).text('Log in');
        if (error) {
            $error.text(error).removeClass('hidden');
            return;
        }
        $('#login_password').val('');
        dialog.close();
    });

    watchAccount((user, reason) => {
        account = user;
        // Signing in shows the account's own org - once per page, and not over an org from the link
        if (user?.orgId && !orgFilterFromAccount && !urlParams.has('org')) {
            orgFilterFromAccount = true;
            setOrgFilter(user.orgId);
        }
        if (!user && (reason === 'no-org' || reason === 'error')) {
            // Signed in, but nothing to operate - say so in the dialog and sign out again
            $error.text(reason === 'no-org' ? "This account isn't linked to an organisation yet." : "Couldn't load this account - please try again.")
                .removeClass('hidden');
            openLogin();
            logout();
        }
        renderAccount();
        scheduleRender();
    });
}

/** Sets the org filter (select and link) - from the select, or the account's org on sign-in. */
function setOrgFilter(org) {
    filters.org = org;
    $('#org_filter').val(org);
    const params = new URLSearchParams(window.location.search);
    if (org) params.set('org', org);
    else params.delete('org');
    const search = params.toString().replace(/=(?=&|$)/g, '');
    history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
    updateTitle();
    render();
}

function bindControls() {
    $('#org_filter').on('change', function () {
        setOrgFilter($(this).val());
    });

    $('#search').on('input', function () {
        filters.query = $(this).val();
        render();
    });

    // Cast: copy the stream link instead of opening it - it goes into OBS
    $(document).on('click', '.copy_stream', async function () {
        const button = this;
        let copied = false;
        try {
            await navigator.clipboard.writeText(button.dataset.link);
            copied = true;
        } catch {
            window.prompt('Copy the stream link:', button.dataset.link);
        }
        if (!copied) return;
        showToast('✅', 'Stream link copied - paste it into OBS as a browser source.');
        const $icon = $(button).find('.material-symbols-rounded');
        $icon.text('check');
        button.title = 'Link copied';
        clearTimeout(button.copyTimeout);
        button.copyTimeout = setTimeout(() => {
            $icon.text('cast');
            button.title = 'Copy the stream link (OBS)';
        }, 1600);
    });

    // A click anywhere on a card opens its scoreboard - except on its own links
    $(document).on('click', '.match_card[data-href]', function (event) {
        if (event.target.closest('a, button')) return;
        if (window.getSelection()?.toString()) return; // selecting text isn't a click
        window.location.href = this.dataset.href;
    });

    $('.section_toggle').on('click', function () {
        const id = $(this).closest('.section').attr('id').replace('section_', '');
        if (collapsed.has(id)) collapsed.delete(id);
        else collapsed.add(id);
        storeCollapsed();
        render();
    });
}

$(function () {
    bindControls();
    renderAccount();
    bindAccount();
    startDataSync();
    // Relative times and running timers
    setInterval(scheduleRender, 1000);
});
