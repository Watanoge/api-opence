/**
 * The social side against a real database: a mongod of its own, started in
 * a temporary folder for these tests (skipped where none is installed).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const MONGOD = spawnSync('which', ['mongod']).stdout?.toString().trim();
const PORT = 27000 + Math.floor(Math.random() * 1000);

function key(letter) {
    return letter.repeat(64);
}

test('friends, presence, activity and moderation', { skip: !MONGOD && 'no mongod' }, async (t) => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'opence-social-'));
    const mongod = spawn(MONGOD, ['--dbpath', folder, '--port', String(PORT), '--bind_ip', '127.0.0.1', '--quiet'],
        { stdio: 'ignore' });
    const cleanUp = () => {
        mongod.kill();
        fs.rmSync(folder, { recursive: true, force: true });
    };
    t.after(cleanUp);
    process.env.MONGODB_URI = `mongodb://127.0.0.1:${PORT}`;
    process.env.MONGODB_DBNAME = 'opence_test';
    const social = require('../database/halo_social');
    try {
        await exercise(social);
    } catch (err) {
        // (a failure: the database stopped and the process ended all the
        // same, which the driver's open connection would keep waiting)
        cleanUp();
        setImmediate(() => process.exit(1));
        throw err;
    }
    cleanUp();
    // (the module's own connection kept open: the test's process ends here)
    setImmediate(() => process.exit(0));
});

async function exercise(social) {
    // (mongod takes a moment to listen)
    let one;
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            one = await social.hello(key('a'), { name: 'One' });
            break;
        } catch (err) {
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    assert.ok(one, 'mongod answered');
    const two = await social.hello(key('b'), { name: 'Two', settings: { requests: true } });
    const three = await social.hello(key('c'), { name: 'Three', settings: { requests: false, privateAnyone: false } });
    assert.strictEqual(three.account.settings.requests, false);
    const codeOne = one.account.code;
    let codeTwo = two.account.code;
    const codeThree = three.account.code;
    // (others know an account by its public id: its code is its own to give)
    const idOf = async (viewer, code) => (await social.getPlayer(key(viewer), code, {})).player.code;
    const idOne = await idOf('b', codeOne);
    const idTwo = await idOf('a', codeTwo);
    const idThree = await idOf('a', codeThree);
    assert.match(idTwo, /^p[0-9a-z]{11}$/);
    assert.strictEqual(await idOf('b', codeTwo), codeTwo);
    assert.strictEqual(await idOf('b', idTwo), codeTwo);

    // (asking: pending, then accepted by the other asking back; the
    // friendships' key in the chat's poll changes each time)
    const keyOf = async (viewer) => (await social.pollChat(key(viewer), {})).friends;
    const keyBefore = await keyOf('a');
    assert.match(keyBefore, /^[0-9a-f]{16}$/);
    assert.strictEqual((await social.requestFriend(key('a'), { code: codeTwo })).state, 'outgoing');
    const keyAsked = await keyOf('a');
    assert.notStrictEqual(keyAsked, keyBefore);
    let friends = await social.getFriends(key('b'));
    assert.deepStrictEqual(friends.incoming.map((row) => row.code), [idOne]);
    assert.strictEqual((await social.requestFriend(key('b'), { code: codeOne })).state, 'friends');
    assert.notStrictEqual(await keyOf('a'), keyAsked);
    assert.strictEqual((await social.setPresence(key('a'), {})).friends, await keyOf('a'));
    // (requests off: only by the code, not from the chat or a page)
    assert.strictEqual((await social.requestFriend(key('a'), { code: idThree })).error.type, 'not_accepting');
    assert.strictEqual((await social.requestFriend(key('a'), { code: codeThree })).state, 'outgoing');
    await social.removeFriend(key('a'), { code: idThree });
    assert.strictEqual((await social.requestFriend(key('a'), { code: codeOne })).status, 422);

    // (a new friend code: the old one finds no one, the friendship stays)
    const changed = await social.changeCode(key('b'));
    assert.notStrictEqual(changed.account.code, codeTwo);
    assert.strictEqual((await social.requestFriend(key('c'), { code: codeTwo })).error.type, 'no_player');
    assert.strictEqual((await social.getFriends(key('a'))).friends[0].code, idTwo);
    assert.strictEqual((await social.changeCode(key('b'))).status, 429);
    codeTwo = changed.account.code;

    // (a name and colour picked: the chat's, whatever a profile says after)
    const named = await social.setAccountName(key('b'), { name: ' Chief\u0007 ', color: '#FF8800' });
    assert.strictEqual(named.account.displayName, 'Chief');
    assert.strictEqual(named.account.nameColor, 'ff8800');
    await social.hello(key('b'), { name: 'Profile' });
    assert.strictEqual((await social.getAccount(key('b'))).account.name, 'Chief');
    assert.strictEqual((await social.setAccountName(key('b'), { name: 'Other' })).status, 429);
    assert.strictEqual((await social.setAccountName(key('b'), { color: 'red' })).status, 422);
    assert.strictEqual((await social.setAccountName(key('b'), {})).status, 422);
    const said = await social.sendChat(key('b'), { channel: 'global', text: 'hello' });
    assert.strictEqual(said.message.name, 'Chief');
    assert.strictEqual(said.message.nameColor, 'ff8800');
    assert.strictEqual((await social.setAccountName(key('b'), { color: '' })).account.nameColor, null);

    // (presence: a friend sees the game and its invite)
    // (and the friendships' key changes with what a friend is doing)
    const invite = `halo://join/${'f'.repeat(64)}`;
    const keyMenus = await keyOf('a');
    const answer = await social.setPresence(key('b'), { state: 'multiplayer', map: 'bloodgulch', host: true, invite });
    assert.strictEqual(answer.friendsOnline, 1);
    assert.notStrictEqual(await keyOf('a'), keyMenus);
    friends = await social.getFriends(key('a'));
    assert.strictEqual(friends.friends[0].code, idTwo);
    assert.strictEqual(friends.friends[0].online, true);
    assert.strictEqual(friends.friends[0].invite, invite);
    await social.hello(key('b'), { settings: { join: false } });
    await social.setPresence(key('b'), { state: 'multiplayer', invite });
    assert.strictEqual((await social.getFriends(key('a'))).friends[0].invite, undefined);
    assert.strictEqual((await social.getFriends(key('a'))).friends[0].private, true);
    // (a public game's, join off or not: its invite, or with a password its listing's key)
    await social.setPresence(key('b'), { state: 'multiplayer', invite, public: true });
    assert.strictEqual((await social.getFriends(key('a'))).friends[0].invite, invite);
    await social.setPresence(key('b'), { state: 'multiplayer', hostKey: 'A'.repeat(32), locked: true, public: true });
    friends = await social.getFriends(key('a'));
    assert.strictEqual(friends.friends[0].hostKey, 'a'.repeat(32));
    assert.strictEqual(friends.friends[0].locked, true);
    assert.strictEqual(friends.friends[0].invite, undefined);
    await social.setPresence(key('b'), { state: 'multiplayer', private: true });
    friends = await social.getFriends(key('a'));
    assert.strictEqual(friends.friends[0].private, true);
    assert.strictEqual(friends.friends[0].hostKey, undefined);
    // (its own card: what it is doing)
    assert.strictEqual((await social.getPlayer(key('b'), codeTwo, {})).player.state, 'multiplayer');
    // (the game closed: offline at once; online again once heard from)
    assert.strictEqual((await social.setOffline(` ${key('b')}\n`)).status, undefined);
    assert.strictEqual((await social.getFriends(key('a'))).friends[0].online, false);
    assert.strictEqual((await social.setOffline('')).status, 401);
    await (await require('../database/db').collection(social.internals.ACCOUNTS)).updateOne({ keyHash: social.internals.hashKey(key('b')) },
        { $set: { offlineAt: new Date(Date.now() - social.internals.OFFLINE_GRACE_MS - 1000) } });
    await social.setPresence(key('b'), { state: 'lobby' });
    friends = await social.getFriends(key('a'));
    assert.strictEqual(friends.friends[0].online, true);
    assert.strictEqual(friends.friends[0].state, 'lobby');

    // (activity: a friend's match)
    await social.submitMatch(key('b'), { matchId: 'match00000001', kind: 'multiplayer', result: 'win', kills: 9, map: 'bloodgulch' });
    // (a match left before its end: not in the activity)
    await social.submitMatch(key('b'), { matchId: 'match00000002', kind: 'multiplayer', completed: false, endReason: 'quit', kills: 2 });
    const activity = await social.getActivity(key('a'), {});
    assert.strictEqual(activity.activity.length, 1);
    assert.strictEqual(activity.activity[0].code, idTwo);
    assert.strictEqual(activity.activity[0].matchId, undefined);
    const player = await social.getPlayer(key('a'), codeTwo, {});
    assert.strictEqual(player.player.relation, 'friends');
    assert.strictEqual(player.player.stats.multiplayer.kills, 11);
    assert.strictEqual(player.player.stats.multiplayer.quits, 1);
    assert.strictEqual(player.player.stats.multiplayer.wins, 1);
    // (its history: the match left before its end too, as it ended)
    assert.strictEqual(player.matches.length, 2);
    assert.strictEqual(player.matches[0].endReason, 'quit');
    assert.strictEqual(player.matches[0].result, null);
    await social.hello(key('b'), { settings: { activity: false } });
    assert.strictEqual((await social.getActivity(key('a'), {})).activity.length, 0);
    assert.strictEqual((await social.getPlayer(key('a'), codeTwo, {})).matches.length, 0);
    assert.strictEqual((await social.getPlayer(key('b'), codeTwo, {})).player.relation, 'self');

    // (chat as IRC: a first poll hears nothing said before it, only where to go on from)
    await social.sendChat(key('c'), { channel: 'global', text: 'said before' });
    const first = await social.pollChat(key('a'), {});
    assert.deepStrictEqual(first.messages, []);
    assert.ok(first.cursor > 0);
    const after = { after: String(first.cursor) };

    // (chat: muted, then blocked, never heard; reported by enough, hidden unless asked)
    await social.sendChat(key('c'), { channel: 'global', text: 'hello from three' });
    let heard = await social.pollChat(key('a'), after);
    assert.ok(heard.messages.some((message) => message.from === idThree));
    await social.moderate(key('a'), { code: codeThree, action: 'mute' });
    heard = await social.pollChat(key('a'), after);
    assert.ok(!heard.messages.some((message) => message.from === idThree));
    let moderation = await social.getModeration(key('a'));
    assert.deepStrictEqual(moderation.muted.map((row) => row.code), [idThree]);
    await social.moderate(key('a'), { code: codeThree, action: 'unmute' });
    assert.ok((await social.pollChat(key('a'), after)).messages.some((message) => message.from === idThree));
    // (one's own lines: by its own code; a private line to one that takes
    // them from friends alone, refused; to a friend, by its id, taken)
    await social.sendChat(key('a'), { channel: 'global', text: 'mine' });
    assert.ok((await social.pollChat(key('a'), after)).messages.some((message) => message.text === 'mine' &&
        message.from === codeOne));
    assert.strictEqual((await social.sendChat(key('a'), { channel: 'private', to: idThree, text: 'hi' })).error.type,
        'friends_only');
    // (and one that takes them from friends alone writes to them alone)
    assert.strictEqual((await social.sendChat(key('c'), { channel: 'private', to: (await idOf('c', codeOne)), text: 'hi' }))
        .error.type, 'own_friends_only');
    const sent = await social.sendChat(key('a'), { channel: 'private', to: idTwo, text: 'to two' });
    assert.strictEqual(sent.message.to, idTwo);
    assert.strictEqual(sent.message.from, codeOne);

    await social.moderate(key('b'), { code: codeOne, action: 'block' });
    assert.strictEqual((await social.getFriends(key('a'))).friends.length, 0);
    assert.strictEqual((await social.sendChat(key('a'), { channel: 'private', to: idTwo, text: 'hi' })).error.type,
        'unavailable');
    assert.strictEqual((await social.requestFriend(key('a'), { code: codeTwo })).error.type, 'unavailable');
    await social.sendChat(key('b'), { channel: 'global', text: 'from two' });
    assert.ok(!(await social.pollChat(key('a'), after)).messages.some((message) => message.from === idTwo));
    await social.moderate(key('b'), { code: codeOne, action: 'unblock' });

    for (const letter of ['d', 'e', 'f'].slice(0, social.internals.REPORTED_HIDE_COUNT)) {
        await social.hello(key(letter), { name: letter });
        const report = await social.moderate(key(letter), { code: codeThree, action: 'report', reason: 'spam' });
        assert.strictEqual(report.reported, true);
        assert.strictEqual(report.muted, true);
    }
    assert.strictEqual((await social.moderate(key('d'), { code: codeThree, action: 'report' })).duplicate, true);
    heard = await social.pollChat(key('a'), after);
    assert.ok(!heard.messages.some((message) => message.from === idThree));
    heard = await social.pollChat(key('a'), { ...after, reported: '1' });
    const reported = heard.messages.find((message) => message.from === idThree);
    assert.ok(reported && reported.reported);

    // (private lines off: none reach it)
    await social.hello(key('c'), { settings: { privateChat: false } });
    assert.strictEqual((await social.sendChat(key('a'), { channel: 'private', to: codeThree, text: 'hi' })).error.type,
        'private_off');

    // (rank and emblem: none on a new account, until its first setup)
    const fresh = await social.hello(key('d'), { name: 'Four' });
    assert.strictEqual(fresh.account.emblem, null);
    assert.strictEqual(fresh.account.xp, null);
    assert.strictEqual(fresh.account.rankDone, false);
    const emblem = { foreground: 4, background: 1, primaryColor: 2, secondaryColor: 3, backgroundColor: 5, nameplate: 0, secondaryLayer: true };
    assert.ok((await social.setupAccount(key('d'), { name: 'Fourth', emblem: null })).error);
    const setUp = await social.setupAccount(key('d'), { name: 'Fourth', color: '5b8cff', emblem });
    assert.strictEqual(setUp.account.displayName, 'Fourth');
    assert.strictEqual(setUp.account.nameColor, '5b8cff');
    assert.deepStrictEqual(setUp.account.emblem, emblem);
    assert.strictEqual(setUp.account.xp, 0);
    // (a colour taken back)
    assert.strictEqual((await social.setupAccount(key('d'), { name: 'Fourth', color: '', emblem })).account.nameColor, null);
    // (raised, never lowered; the catch-up said done)
    assert.strictEqual((await social.hello(key('d'), { xp: 9000 })).account.xp, 9000);
    assert.strictEqual((await social.hello(key('d'), { xp: 10 })).account.xp, 9000);
    assert.strictEqual((await social.setRank(key('d'), { xp: 10, done: true })).account.xp, 9000);
    assert.strictEqual((await social.setRank(key('d'), { xp: 12000, done: true })).account.rankDone, true);
    const seen = await social.getPlayer(key('a'), (await social.getAccount(key('d'))).account.code);
    assert.strictEqual(seen.player.xp, 12000);
    assert.deepStrictEqual(seen.player.emblem, emblem);
    assert.strictEqual(seen.player.rankDone, undefined);
    // (the emblem changed; a bad one refused)
    const other = { ...emblem, foreground: 7 };
    assert.deepStrictEqual((await social.setEmblem(key('d'), { emblem: other })).account.emblem, other);
    assert.ok((await social.setEmblem(key('d'), { emblem: { foreground: 999 } })).error);
    // (the room's players carry them, by the name the game shows)
    await social.pollChat(key('d'), { room: 'rankroom', name: 'Four' });
    const members = (await social.pollChat(key('a'), { room: 'rankroom' })).members;
    const member = members.find((row) => row.player === 'Four');
    assert.strictEqual(member.xp, 12000);
    assert.deepStrictEqual(member.emblem, other);
    // (cleared, for testing: to be counted again)
    const cleared = await social.setRank(key('d'), { reset: true });
    assert.strictEqual(cleared.account.xp, 0);
    assert.strictEqual(cleared.account.rankDone, false);
    assert.deepStrictEqual(cleared.account.emblem, other);

    const { MongoClient } = require('mongodb');
    const client = await new MongoClient(process.env.MONGODB_URI).connect();
    await client.db('opence_test').dropDatabase();
    await client.close();
}
