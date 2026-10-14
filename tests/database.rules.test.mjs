import { test, before, after, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { ref, get, set, update, remove } from 'firebase/database';

// Runs against the local emulator: npm run test:rules (requires Java)
const RULES = readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8');

const UID = {
  france: 'uid-france',
  germany2: 'uid-germany-2',
  belgium2: 'uid-belgium-2',
  admin: 'uid-admin',
  orphan: 'uid-account-without-org',
  stranger: 'uid-self-registered-nobody',
};

// Small excerpt in the format produced by scripts/migrate-to-orgs.mjs
const SEED = {
  orgs: {
    // France has enough channels that Firebase stores them as a sparse array
    roundnetfrance: { name: 'Roundnet France', channels: { 6: 1, 7: 2, 8: 3, 9: 4, 10: 5, 11: 6, 12: 7, 13: 8, 14: 9, 15: 10, 16: 11, 23: 12 } },
    roundnetgermany: { name: 'Roundnet Germany', channels: { 1: 1, 20: 6 } },
    roundnetbelgium: { name: 'Roundnet Belgium', channels: { 18: 1 } },
  },
  accounts: {
    [UID.france]: { org: 'roundnetfrance', role: 'operator' },
    [UID.germany2]: { org: 'roundnetgermany', role: 'operator' },
    [UID.belgium2]: { org: 'roundnetbelgium', role: 'operator' },
    [UID.admin]: { org: 'roundnetgermany', role: 'admin' },
    [UID.orphan]: { role: 'operator' },
  },
  users: { legacy: { account_mail: 'legacy@example.test', channels: '1' } },
  bridgeConfig: { fwango: { eventName: '' } },
  'match-1': { phase: 'Squad Final', timer: { type: 'timeout', started_at: 1 } },
  'match-6': { phase: '' },
  'match-11': { phase: '', timer: { type: 'break', started_at: 1 } },
  'match-18': { phase: '' },
  'match-20': { phase: '' },
  'match-23': { phase: '' },
  'match-40': { phase: '' },
};

let env;
const db = (who) => (who ? env.authenticatedContext(UID[who]) : env.unauthenticatedContext()).database();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-scoreboard',
    database: { host: '127.0.0.1', port: 9000, rules: RULES },
  });
});
after(async () => env?.cleanup());

const reseed = () => env.withSecurityRulesDisabled((ctx) => set(ref(ctx.database()), SEED));

describe('read', () => {
  before(reseed);
  test('anyone reads matches, orgs, bridgeConfig', async () => {
    for (const p of ['match-1', 'match-40', 'orgs', 'orgs/roundnetfrance/channels/23', 'bridgeConfig'])
      await assertSucceeds(get(ref(db(null), p)));
  });
  test('nobody reads root, old users or accounts anonymously', async () => {
    for (const p of ['/', 'users', 'accounts', `accounts/${UID.france}`])
      await assertFails(get(ref(db(null), p)));
  });
  test('account reads its own entry, not others or the list', async () => {
    await assertSucceeds(get(ref(db('france'), `accounts/${UID.france}`)));
    await assertFails(get(ref(db('france'), `accounts/${UID.admin}`)));
    await assertFails(get(ref(db('france'), 'accounts')));
    await assertFails(get(ref(db('france'), 'users')));
    await assertFails(get(ref(db('stranger'), 'accounts')));
  });
  test('admin reads the full account list', async () => {
    await assertSucceeds(get(ref(db('admin'), 'accounts')));
    await assertSucceeds(get(ref(db('admin'), `accounts/${UID.france}`)));
  });
  test('loadAccount() reads in the app succeed', async () => {
    const d = db('france');
    const [acc, orgs] = await Promise.all([get(ref(d, `accounts/${UID.france}`)), get(ref(d, 'orgs'))]);
    if (acc.val().org !== 'roundnetfrance' || acc.val().role !== 'operator' || orgs.val().roundnetfrance.channels[23] !== 12)
      throw new Error('unexpected account data');
  });
});

describe('write matches', () => {
  before(reseed);
  test('anonymous cannot write any match', async () => {
    await assertFails(set(ref(db(null), 'match-1/score/set_1/team_a_score'), 5));
    await assertFails(set(ref(db(null), 'match-99'), { x: 1 }));
  });
  test('operator writes own channels (first and last)', async () => {
    await assertSucceeds(set(ref(db('france'), 'match-6/score/set_1/team_a_score'), 5));
    await assertSucceeds(set(ref(db('france'), 'match-23/phase'), 'Final'));
  });
  test('second account of an org can write too', async () => {
    await assertSucceeds(set(ref(db('germany2'), 'match-20/phase'), 'x'));
    await assertSucceeds(set(ref(db('belgium2'), 'match-18/phase'), 'x'));
  });
  test('operator cannot write other orgs / unowned / new channels', async () => {
    await assertFails(set(ref(db('france'), 'match-1/phase'), 'hacked'));
    await assertFails(set(ref(db('france'), 'match-40/phase'), 'x'));
    await assertFails(set(ref(db('france'), 'match-99'), { x: 1 }));
    await assertFails(set(ref(db('germany2'), 'match-6/phase'), 'x'));
  });
  test('signed-in account without org or without entry cannot write', async () => {
    for (const who of ['orphan', 'stranger']) {
      await assertFails(set(ref(db(who), 'match-1/phase'), 'x'));
      await assertFails(set(ref(db(who), 'match-40/phase'), 'x'));
    }
  });
  test('admin writes any match, incl. unowned and new', async () => {
    await assertSucceeds(set(ref(db('admin'), 'match-6/phase'), 'x'));
    await assertSucceeds(set(ref(db('admin'), 'match-40/phase'), 'x'));
    await assertSucceeds(set(ref(db('admin'), 'match-99/phase'), 'x'));
  });
  test('app-style multi-path update at root: own channel ok, mixed with foreign channel fails', async () => {
    await assertSucceeds(update(ref(db('france')), {
      '/match-6/event_history': [{ type: 'reset' }], '/match-6/score/set_1/team_b_score': 3 }));
    await assertFails(update(ref(db('france')), {
      '/match-6/phase': 'a', '/match-1/phase': 'b' }));
  });
  test('timer: remove() on own channel ok, foreign channel fails', async () => {
    await assertSucceeds(remove(ref(db('france'), 'match-11/timer')));
    await assertFails(remove(ref(db('france'), 'match-1/timer')));
  });
});

describe('write config nodes', () => {
  before(reseed);
  test('operators cannot change mappings, orgs or roles', async () => {
    const d = db('france');
    await assertFails(set(ref(d, 'orgs/roundnetfrance/channels/1'), 13));
    await assertFails(set(ref(d, 'orgs/roundnetgermany/name'), 'x'));
    await assertFails(set(ref(d, `accounts/${UID.france}/org`), 'roundnetgermany'));
    await assertFails(set(ref(d, `accounts/${UID.france}/role`), 'admin'));
    await assertFails(set(ref(d, 'users/x'), { channels: '1' }));
    await assertFails(set(ref(d, 'bridgeConfig/x'), 1));
    await assertFails(set(ref(d, 'somethingNew'), 1));
    await assertFails(set(ref(d, '/'), null));
  });
  test('stranger cannot create an account entry or promote itself', async () => {
    const d = db('stranger');
    await assertFails(set(ref(d, `accounts/${UID.stranger}`), { org: 'roundnetgermany', role: 'admin' }));
    await assertFails(set(ref(d, `accounts/${UID.stranger}/role`), 'admin'));
  });
  test('admin can write bridgeConfig, not orgs or accounts (console only)', async () => {
    await assertSucceeds(set(ref(db('admin'), 'bridgeConfig/fwango/eventName'), 'x'));
    await assertFails(set(ref(db('admin'), 'orgs/roundnetfrance/channels/1'), 13));
    await assertFails(set(ref(db('admin'), `accounts/${UID.france}/role`), 'admin'));
  });
});
