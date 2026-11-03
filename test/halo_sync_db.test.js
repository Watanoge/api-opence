/**
 * Account sync: its codes, what an install brings into the account it joins,
 * the skulls and the leaderboards; against a real database (a mongod of its
 * own, skipped where none is installed), the skulls' rules without one.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MONGOD = spawnSync('which', ['mongod']).stdout?.toString().trim();
const PORT = 28000 + Math.floor(Math.random() * 1000);

function key(letter) {
    return letter.repeat(64);
}

test('skulls: unlocks add up, the style follows its version, a reset starts an epoch', () => {
    process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:1';
    const { internals } = require('../database/halo_sync');
    const { mergeSkulls } = internals;

    let skulls = mergeSkulls(undefined, { unlocked: 'anger,fog,bad key,fog', epoch: -1 });
    assert.deepStrictEqual(skulls.unlocked, ['anger', 'fog']);
    assert.strictEqual(skulls.version, 0);

    // (a device that has seen the last version changes the style; one that has not, does not)
    const style = { mode: 'play', all: false, instant: true, lose: false };
    skulls = mergeSkulls(skulls, { style, version: 0, epoch: -1 });
    assert.strictEqual(skulls.version, 1);
    assert.deepStrictEqual(skulls.style, style);
    const behind = mergeSkulls(skulls, { style: { mode: 'play', all: true, instant: false, lose: true }, version: 0, unlocked: 'iron' });
    assert.deepStrictEqual(behind.style, style);
    assert.strictEqual(behind.version, 1);
    assert.deepStrictEqual(behind.unlocked, ['anger', 'fog', 'iron']);

    // (a reset: nothing unlocked, a new epoch; a device of the old epoch cannot bring its skulls back)
    const reset = mergeSkulls(behind, { reset: true, style: { mode: '', all: false, instant: false, lose: true }, epoch: 0, version: 1 });
    assert.strictEqual(reset.epoch, 1);
    assert.deepStrictEqual(reset.unlocked, []);
    assert.deepStrictEqual(mergeSkulls(reset, { unlocked: 'anger,fog', epoch: 0 }).unlocked, []);
    assert.deepStrictEqual(mergeSkulls(reset, { unlocked: 'anger', epoch: 1 }).unlocked, ['anger']);
    // (a style that is not valid is not taken)
    assert.deepStrictEqual(mergeSkulls(behind, { style: { mode: 'weird' }, version: 1 }).style, style);
});

test('account sync', { skip: !MONGOD && 'no mongod' }, async (t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'opence-sync-'));
    const mongod = spawn(MONGOD, ['--dbpath', folder, '--port', String(PORT), '--bind_ip', '127.0.0.1', '--quiet'],
        { stdio: 'ignore' });
    const cleanUp = () => {
        mongod.kill();
        fs.rmSync(folder, { recursive: true, force: true });
    };
    t.after(cleanUp);
    process.env.MONGODB_URI = `mongodb://127.0.0.1:${PORT}`;
    process.env.MONGODB_DBNAME = 'opence_sync_test';
    try {
        await exercise();
    } catch (err) {
        cleanUp();
        setImmediate(() => process.exit(1));
        throw err;
    }
    cleanUp();
    setImmediate(() => process.exit(0));
});

async function exercise() {
    const social = require('../database/halo_social');
    const sync = require('../database/halo_sync');
    const sql = require('../database/halo_sql');
    let a;
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            a = await social.hello(key('a'), { name: 'Alpha' });
            break;
        } catch (err) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    assert.ok(a, 'mongod answered');
    assert.strictEqual(a.account.synced, false);
    const b = await social.hello(key('b'), { name: 'Beta' });
    const c = await social.hello(key('c'), { name: 'Gamma' });
    const d = await social.hello(key('d'), { name: 'Delta' });

    // (what each has before: a friend, a match and a medal each)
    await social.requestFriend(key('a'), { code: c.account.code });
    await social.requestFriend(key('c'), { code: a.account.code });
    await social.requestFriend(key('b'), { code: d.account.code });
    await social.requestFriend(key('d'), { code: b.account.code });
    await social.requestFriend(key('b'), { code: c.account.code });
    await social.submitMatch(key('a'), { matchId: 'match-alpha-1', kind: 'multiplayer', result: 'win', kills: 10, deaths: 2, medals: { double_kill: 1 } });
    await social.submitMatch(key('b'), { matchId: 'match-beta-01', kind: 'multiplayer', result: 'loss', kills: 3, deaths: 9, medals: { double_kill: 2, headshot: 1 } });

    // (a leaderboard record of each install's profile of the same name, before they are synced)
    const level = [...sql.internals.LEVEL_KEYS][0];
    const run = (name, score, seconds) => ({ name, level, score, seconds, difficulty: 1 });
    await sql.submitLevelScore(`${key('a')}-aaaa1111`, run('Alpha', 500, 600));
    await sql.submitLevelScore(`${key('b')}-aaaa1111`, run('Beta', 900, 700));
    await sql.submitLevelScore(`${key('b')}-bbbb2222`, run('Beta2', 100, 700));

    // (a code: made, kept alive, and good only while it is)
    const t0 = Date.now();
    const made = await sync.createSyncCode(key('a'), { skulls: { unlocked: 'anger', style: { mode: 'play', all: false, instant: true, lose: true }, version: 0, epoch: -1 } }, t0);
    assert.match(made.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.strictEqual(made.skulls.version, 1);
    const kept = await sync.createSyncCode(key('a'), { code: made.code }, t0 + 30000);
    assert.strictEqual(kept.code, made.code);
    // (45 seconds without being asked for: no longer good, and another is made)
    assert.strictEqual((await sync.redeemSyncCode(key('b'), { code: made.code }, t0 + 30000 + 46000)).error.type, 'invalid_code');
    const again = await sync.createSyncCode(key('a'), { code: made.code }, t0 + 120000);
    assert.notStrictEqual(again.code, made.code);
    // (the screen left: no longer good)
    await sync.cancelSyncCode(key('a'));
    assert.strictEqual((await sync.redeemSyncCode(key('b'), { code: again.code })).error.type, 'invalid_code');
    // (a code of a friend's account, one that is not a code, and one's own account's)
    assert.strictEqual((await sync.redeemSyncCode(key('b'), { code: c.account.code })).error.type, 'invalid_code');
    assert.strictEqual((await sync.redeemSyncCode(key('b'), { code: 'nope' })).status, 422);
    const own = await sync.createSyncCode(key('a'), {});
    assert.strictEqual((await sync.redeemSyncCode(key('a'), { code: own.code })).error.type, 'same_account');
    // (wrong codes: only so many)
    sync.internals.tries.clear();
    for (let index = 0; index < sync.internals.SYNC_TRIES; index++) {
        await sync.redeemSyncCode(key('z'), { code: '0000-0000' });
    }
    assert.strictEqual((await sync.redeemSyncCode(key('z'), { code: own.code })).status, 429);

    // (the code typed on another install)
    const joined = await sync.redeemSyncCode(key('b'), { code: own.code });
    assert.strictEqual(joined.error, undefined);
    assert.strictEqual(joined.account.code, a.account.code);
    assert.strictEqual(joined.account.synced, true);
    assert.strictEqual(joined.account.stats.multiplayer.matches, 2);
    assert.strictEqual(joined.account.stats.multiplayer.kills, 13);
    assert.strictEqual(joined.account.medals.double_kill, 3);
    assert.strictEqual(joined.skulls.unlocked, 'anger');
    assert.strictEqual(joined.skulls.style.instant, true);
    // (taken once; and an install already synced takes no other)
    assert.strictEqual((await sync.redeemSyncCode(key('d'), { code: own.code })).error.type, 'invalid_code');
    const other = await sync.createSyncCode(key('c'), {});
    assert.strictEqual((await sync.redeemSyncCode(key('b'), { code: other.code })).error.type, 'already_synced');
    assert.strictEqual((await social.getAccount(key('b'))).account.code, a.account.code);
    assert.strictEqual((await social.getAccount(key('a'))).account.synced, true);

    // (both installs are one account: its friends (those of both), its matches)
    for (const install of ['a', 'b']) {
        const friends = await social.getFriends(key(install));
        const names = friends.friends.map((row) => row.name).sort();
        assert.deepStrictEqual(names, ['Delta', 'Gamma'], `friends of ${install}`);
        assert.strictEqual((await social.getMatches(key(install), {})).matches.length, 2);
    }
    // (a friend of one of them, a friend of the account)
    assert.strictEqual((await social.getFriends(key('c'))).friends.length, 1);
    // (a match of the second install counts for the account)
    await social.submitMatch(key('b'), { matchId: 'match-beta-02', kind: 'multiplayer', result: 'win', kills: 7 });
    assert.strictEqual((await social.getAccount(key('a'))).account.stats.multiplayer.kills, 20);
    assert.strictEqual((await social.getAccount(key('b'))).account.stats.multiplayer.wins, 2);

    // (the leaderboard: the account's profile of the name has the better of the two, the other its own)
    // (the primary's own records move the first time it asks)
    await sql.getLevelLeaderboard(level, { limit: 10 }, `${key('a')}-aaaa1111`);
    const board = await sql.getLevelLeaderboard(level, { limit: 10 }, `${key('b')}-aaaa1111`);
    assert.strictEqual(board.me.score, 900);
    assert.strictEqual(board.rows.filter((row) => ['Alpha', 'Beta'].includes(row.name)).length, 1);
    const fromA = await sql.getLevelLeaderboard(level, { limit: 10 }, `${key('a')}-aaaa1111`);
    assert.strictEqual(fromA.me.id, board.me.id);
    const second = await sql.getLevelLeaderboard(level, { limit: 10 }, `${key('b')}-bbbb2222`);
    assert.strictEqual(second.me.score, 100);
    assert.notStrictEqual(second.me.id, board.me.id);
    // (a score from the other install improves the same record)
    const better = await sql.submitLevelScore(`${key('a')}-aaaa1111`, run('Alpha', 1200, 500));
    assert.strictEqual(better.improved, true);
    assert.strictEqual((await sql.getLevelLeaderboard(level, { limit: 10 }, `${key('b')}-aaaa1111`)).me.score, 1200);

    // (the skulls: unlocked on one, unlocked on the other; the style of the one that saw the last)
    let skulls = (await sync.syncSkulls(key('b'), { unlocked: 'fog', epoch: -1, version: 0 })).skulls;
    assert.strictEqual(skulls.unlocked, 'anger,fog');
    skulls = (await sync.syncSkulls(key('a'), { unlocked: 'anger', epoch: skulls.epoch, version: skulls.version,
        style: { mode: 'play', all: true, instant: true, lose: true } })).skulls;
    assert.strictEqual(skulls.unlocked, 'anger,fog');
    assert.strictEqual(skulls.style.all, true);
    assert.strictEqual((await sync.syncSkulls(key('b'), null)).skulls.version, skulls.version);
    const reset = (await sync.syncSkulls(key('b'), { reset: true, epoch: skulls.epoch, version: skulls.version,
        style: { mode: '', all: false, instant: false, lose: true } })).skulls;
    assert.strictEqual(reset.unlocked, '');
    assert.strictEqual((await sync.syncSkulls(key('a'), { unlocked: 'anger,fog', epoch: skulls.epoch })).skulls.unlocked, '');
}
