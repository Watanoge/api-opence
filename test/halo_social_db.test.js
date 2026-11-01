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
    const codeTwo = two.account.code;
    const codeThree = three.account.code;
    // (others know an account by its public id: its code is its own to give)
    const idOf = async (viewer, code) => (await social.getPlayer(key(viewer), code, {})).player.code;
    const idOne = await idOf('b', codeOne);
    const idTwo = await idOf('a', codeTwo);
    const idThree = await idOf('a', codeThree);
    assert.match(idTwo, /^p[0-9a-z]{11}$/);
    assert.strictEqual(await idOf('b', codeTwo), codeTwo);
    assert.strictEqual(await idOf('b', idTwo), codeTwo);

    // (asking: pending, then accepted by the other asking back)
    assert.strictEqual((await social.requestFriend(key('a'), { code: codeTwo })).state, 'outgoing');
    let friends = await social.getFriends(key('b'));
    assert.deepStrictEqual(friends.incoming.map((row) => row.code), [idOne]);
    assert.strictEqual((await social.requestFriend(key('b'), { code: codeOne })).state, 'friends');
    // (requests off: only by the code, not from the chat or a page)
    assert.strictEqual((await social.requestFriend(key('a'), { code: idThree })).error.type, 'not_accepting');
    assert.strictEqual((await social.requestFriend(key('a'), { code: codeThree })).state, 'outgoing');
    await social.removeFriend(key('a'), { code: idThree });
    assert.strictEqual((await social.requestFriend(key('a'), { code: codeOne })).status, 422);

    // (presence: a friend sees the game and its invite)
    const invite = `halo://join/${'f'.repeat(64)}`;
    const answer = await social.setPresence(key('b'), { state: 'multiplayer', map: 'bloodgulch', host: true, invite });
    assert.strictEqual(answer.friendsOnline, 1);
    friends = await social.getFriends(key('a'));
    assert.strictEqual(friends.friends[0].code, idTwo);
    assert.strictEqual(friends.friends[0].online, true);
    assert.strictEqual(friends.friends[0].invite, invite);
    await social.hello(key('b'), { settings: { join: false } });
    await social.setPresence(key('b'), { state: 'multiplayer', invite });
    assert.strictEqual((await social.getFriends(key('a'))).friends[0].invite, undefined);

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

    const { MongoClient } = require('mongodb');
    const client = await new MongoClient(process.env.MONGODB_URI).connect();
    await client.db('opence_test').dropDatabase();
    await client.close();
}
