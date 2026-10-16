// Fills the local Firebase emulators (database + auth) with a test org, an
// operator account and a sample match, for trying the panel out locally:
//
//   firebase emulators:start --only database,auth --project live-scoreboard-fc0e5
//   node scripts/seed-emulator.mjs
//   open http://localhost:5517/input.html?emulator  (login below)
//   and  http://localhost:5517/index.html?emulator&org=testorg&court=1
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
const data = {
    orgs: { testorg: { name: 'Test Org', channels: { 1: 1, 2: 2 } } },
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
};

const res = await fetch(`http://127.0.0.1:9000/.json?ns=${NS}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer owner' },
    body: JSON.stringify(data),
});
if (!res.ok) throw new Error(`Seeding the database failed: ${res.status}`);
console.log(`Seeded. Log in with ${EMAIL} / ${PASSWORD}`);
