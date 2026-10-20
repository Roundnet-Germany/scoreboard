// Fills the local Firebase emulators (database + auth) with a test org, an
// operator account and a sample match, for trying the panel out locally:
//
//   firebase emulators:start --only database,auth --project live-scoreboard-fc0e5
//   node scripts/seed-emulator.mjs
//   open http://localhost:5517/input.html?emulator  (login below)
//   and  http://localhost:5517/index.html?emulator&org=testorg&court=1
//   and  http://localhost:5517/overview.html?emulator  (courts 2-6: one per overview state,
//        channels 7-9: one squad game with three subgames on Test Org's courts 5-7)
//
// Only ever talks to 127.0.0.1 - these credentials exist in the emulator only.

const EMAIL = 'operator@example.test';
const PASSWORD = 'emulator-only-123';
const NS = 'live-scoreboard-fc0e5-default-rtdb';

const signUp = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
}).then((r) => r.json());

let uid = signUp.localId;
if (!uid) {
    // Already there from an earlier run
    const signIn = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
    }).then((r) => r.json());
    uid = signIn.localId;
}
if (!uid) throw new Error('Could not create the test account - is the auth emulator running?');

const team = (name, p1, p2, color, flag) => ({ name, player_1: p1, player_2: p2, color, flag });
const sets = (...pairs) => Object.fromEntries(pairs.map(([a, b], i) => [`set_${i + 1}`, { team_a_score: a, team_b_score: b, starting_server: i % 2 ? 'c' : 'a', starting_receiver: i % 2 ? 'a' : 'c' }]));
const flags = { admin_settings: { show_flag: 1, show_color: 0, show_player_names: 1 } };
const minutesAgo = (minutes) => Date.now() - minutes * 60_000;
// Further courts for the live overview, one per state it tells apart
const overviewMatch = (phase, a, b, score, activeSet, updatedAt, extra = {}) => ({
    tournament_name: 'Emulator Open', phase, active_set: activeSet, updated_at: updatedAt,
    game_settings: { set_mode: 'Best of 3', win_points: 15, hardcap: 21 },
    teams_info: { team_a: a, team_b: b }, score, ...extra,
});
// Squad game (liga): subgames of one Playerzone main game on several courts,
// squad names on every court like the Playerzone's import sends them
const SQUAD_GAME = 900100;
const squads = { a: { name: 'Rhein Rockets', color: '#0ea5e9' }, b: { name: 'Isar Eagles', color: '#f59e0b' } };
const subgame = (gameId, title, playersA, playersB, score, activeSet, updatedAt) => overviewMatch(title,
    team(squads.a.name, ...playersA, squads.a.color, ''), team(squads.b.name, ...playersB, squads.b.color, ''),
    score, activeSet, updatedAt, {
        tournament_name: 'Emulator Liga · Matchday 3',
        playerzone: { game_id: gameId, main_game_id: SQUAD_GAME, event_id: 2 },
        admin_settings: { show_color: 1, show_player_names: 1 },
    });
const squadLive = (gameId, channel, court, since) => ({ channel, main_game_id: SQUAD_GAME, org: 'testorg', court, since: minutesAgo(since) });
const data = {
    orgs: {
        testorg: { name: 'Test Org', channels: { 1: 1, 2: 2, 3: 3, 4: 4, 7: 5, 8: 6, 9: 7 } },
        otherorg: { name: 'Other Org', channels: { 5: 1, 6: 2 } },
    },
    live_games: {
        900001: { channel: 2, main_game_id: null, org: 'testorg', court: 2, since: minutesAgo(25) },
        900101: squadLive(900101, 7, 5, 40),
        900102: squadLive(900102, 8, 6, 35),
        900103: squadLive(900103, 9, 7, 30),
    },
    accounts: { [uid]: { org: 'testorg', role: 'operator', email: EMAIL } },
    'match-1': {
        phase: 'Test Final',
        active_set: 1,
        teams_info: {
            team_a: team('Alpha', 'Anna Adler', 'Ben Berg', '#d62828', 'DE'),
            team_b: team('Beta', 'Cora Cruz', 'Dan Dorn', '#1d4ed8', 'FR'),
        },
        score: { set_1: { team_a_score: 0, team_b_score: 0, starting_server: 'a', starting_receiver: 'c' } },
        event_history: [{ type: 'reset' }],
        admin_settings: { show_player_names: 1, show_color: 1, show_score_history: 1, show_score_history_chart: 1, show_serve_indicator: 1 },
    },
    // Live, linked to a (made-up) Playerzone game, timeout running, match point
    'match-2': overviewMatch('Semifinal 1', team('Germany', 'Lena Lang', 'Mia Moos', '#111111', 'DE'),
        team('Netherlands', 'Noor Visser', 'Eva Bos', '#f97316', 'NL'), sets([15, 11], [14, 12]), 2, minutesAgo(0.5),
        { playerzone: { game_id: 900001, main_game_id: null, event_id: 1 }, timer: { type: 'timeout', started_at: minutesAgo(0.3) }, ...flags }),
    // Live, third set, squad score shown (liga)
    'match-3': overviewMatch('Group A', team('Spike Brothers', 'Tom Tal', 'Max Mohn', '#2563eb', ''),
        team('Net Ninjas', 'Ole Ott', 'Paul Pohl', '#16a34a', ''), { ...sets([12, 15], [15, 13], [6, 4]), squad_score: { team_a_score: 2, team_b_score: 1 } }, 3, minutesAgo(1),
        { admin_settings: { show_group_score: 1, show_color: 1, show_player_names: 1 } }),
    // Finished a few minutes ago
    'match-4': overviewMatch('Group B', team('Roundhouse', 'Ida Ilg', 'Jan Jung', '#9333ea', ''),
        team('Ballers', 'Kai Kern', 'Lea Lutz', '#dc2626', ''), sets([15, 8], [15, 10]), 2, minutesAgo(4)),
    // Inactive: last change hours ago
    'match-5': overviewMatch('Quarterfinal', team('France', 'Luc Roux', 'Hugo Petit', '#1d4ed8', 'FR'),
        team('Belgium', 'Bram Peeters', 'Wout Claes', '#facc15', 'BE'), sets([9, 7]), 1, minutesAgo(180), flags),
    // Game loaded, no points yet
    'match-6': overviewMatch('Final', team('Austria', 'Anna Huber', 'Lisa Gruber', '#ef4444', 'AT'),
        team('Switzerland', 'Nina Meier', 'Sara Keller', '#b91c1c', 'CH'), sets([0, 0]), 1, minutesAgo(2), flags),
    // Squad game: Rockets won the men's game, Eagles the women's, mixed is on (1:1)
    'match-7': subgame(900101, 'Men', ['Finn Falk', 'Jonas Jost'], ['Erik Ehm', 'Leon Lenz'], sets([15, 9], [15, 12]), 2, minutesAgo(6)),
    'match-8': subgame(900102, 'Women', ['Clara Cole', 'Hanna Hirt'], ['Greta Gaul', 'Sophie Sand'], sets([13, 15], [10, 15]), 2, minutesAgo(3)),
    'match-9': subgame(900103, 'Mixed', ['Lukas Lind', 'Marie Mohr'], ['Felix Frey', 'Tina Thal'], sets([15, 13], [9, 11]), 2, minutesAgo(0.4)),
};

const res = await fetch(`http://127.0.0.1:9000/.json?ns=${NS}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner' },
    body: JSON.stringify(data),
});
if (!res.ok) throw new Error(`Seeding the database failed: ${res.status}`);
console.log(`Seeded. Log in with ${EMAIL} / ${PASSWORD}`);
