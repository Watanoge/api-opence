const test = require('node:test');
const assert = require('node:assert');
const { internals: social } = require('../database/halo_social');

const INSTALL = 'a'.repeat(64);

test('the account is the install, whatever its profile', () => {
    assert.strictEqual(social.accountKey(INSTALL), INSTALL);
    assert.strictEqual(social.accountKey(`${INSTALL}-1a2b3c4d`), INSTALL);
    assert.strictEqual(social.accountKey(` ${INSTALL}-1a2b3c4d `), INSTALL);
    // (another key the leaderboards take is an account of its own)
    assert.strictEqual(social.accountKey('k'.repeat(40)), 'k'.repeat(40));
    assert.strictEqual(social.accountKey('short'), null);
    assert.strictEqual(social.accountKey(undefined), null);
});

test('codes are made in their alphabet and read back as typed', () => {
    for (let index = 0; index < 200; index++) {
        const code = social.newCode();
        assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
        assert.strictEqual(social.normalizeCode(code.toLowerCase().replace('-', ' ')), code);
    }
    assert.strictEqual(social.normalizeCode('oiL1-2345'), '0111-2345');
    assert.strictEqual(social.normalizeCode('ABCD-EFGU'), null);
    assert.strictEqual(social.normalizeCode('ABC'), null);
});

test('a match is checked and adds to its kind', () => {
    const { errors, match } = social.parseMatch({
        matchId: 'abcdef0123456789', kind: 'multiplayer', result: 'win', score: 25, kills: 25, deaths: 7,
        assists: 4, seconds: 600, players: 8, map: 'bloodgulch', gametype: 'Slayer', teams: true,
        medals: { double_kill: 3, headshot: 2, zero: 0 },
    });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(match.medals, { double_kill: 3, headshot: 2 });
    const increments = social.matchIncrements(match);
    assert.strictEqual(increments['stats.multiplayer.matches'], 1);
    assert.strictEqual(increments['stats.multiplayer.wins'], 1);
    assert.strictEqual(increments['stats.multiplayer.kills'], 25);
    assert.strictEqual(increments['stats.multiplayer.medals'], 5);
    assert.strictEqual(increments['medals.double_kill'], 3);
    assert.strictEqual(increments['stats.multiplayer.losses'], undefined);

    assert.ok(social.parseMatch({ kind: 'multiplayer' }).errors.includes('matchId is required'));
    assert.ok(social.parseMatch({ matchId: 'abcdef0123', kind: 'deathmatch' }).errors.length);
    assert.ok(social.parseMatch({ matchId: 'abcdef0123', kind: 'campaign', kills: -1 }).errors.length);
    assert.ok(social.parseMatch({ matchId: 'abcdef0123', kind: 'campaign', medals: { 'Bad Key': 1 } }).errors.length);
    assert.ok(social.parseMatch({ matchId: 'abcdef0123', kind: 'campaign', result: 'draw' }).errors.length);
});

test('a match left before its end counts its figures, a quit as a quit, never a result', () => {
    const quit = social.parseMatch({
        matchId: 'abcdef0123456789', kind: 'multiplayer', result: 'loss', completed: false, endReason: 'quit',
        kills: 4, deaths: 6, seconds: 300, medals: { double_kill: 1 },
    });
    assert.deepStrictEqual(quit.errors, []);
    assert.strictEqual(quit.match.result, null);
    assert.strictEqual(quit.match.completed, false);
    assert.strictEqual(quit.match.endReason, 'quit');
    const increments = social.matchIncrements(quit.match);
    assert.strictEqual(increments['stats.multiplayer.matches'], 1);
    assert.strictEqual(increments['stats.multiplayer.quits'], 1);
    assert.strictEqual(increments['stats.multiplayer.kills'], 4);
    assert.strictEqual(increments['medals.double_kill'], 1);
    assert.strictEqual(increments['stats.multiplayer.losses'], undefined);

    const ended = social.parseMatch({ matchId: 'abcdef0123456789', kind: 'multiplayer', completed: false, endReason: 'ended' });
    assert.deepStrictEqual(ended.errors, []);
    assert.strictEqual(social.matchIncrements(ended.match)['stats.multiplayer.quits'], undefined);

    const done = social.parseMatch({ matchId: 'abcdef0123456789', kind: 'multiplayer', result: 'win', endReason: 'quit' });
    assert.strictEqual(done.match.completed, true);
    assert.strictEqual(done.match.endReason, null);
    assert.strictEqual(social.matchIncrements(done.match)['stats.multiplayer.quits'], undefined);

    assert.ok(social.parseMatch({ matchId: 'abcdef0123', kind: 'multiplayer', completed: false }).errors.length);
    assert.ok(social.parseMatch({ matchId: 'abcdef0123', kind: 'multiplayer', completed: false, endReason: 'rage' }).errors.length);
});

test('totals read zero where none was kept', () => {
    assert.deepStrictEqual(social.publicTotals({ kills: 3 }), {
        matches: 0, wins: 0, losses: 0, ties: 0, quits: 0, score: 0, kills: 3, deaths: 0, assists: 0, suicides: 0,
        betrayals: 0, seconds: 0, medals: 0,
    });
});

test('chat text and rooms are checked', () => {
    assert.strictEqual(social.parseChatText('  hi\u0007 there '), 'hi  there');
    assert.strictEqual(social.parseChatText('   '), null);
    assert.strictEqual(social.parseChatText('x'.repeat(500)).length, 200);
    assert.strictEqual(social.parseRoom('p2p:0123abcd'), 'p2p:0123abcd');
    assert.strictEqual(social.parseRoom('bad room'), null);
    assert.strictEqual(social.parseRoom('x'.repeat(97)), null);
});

test('an account says CHAT_BURST lines at once, then one a refill', () => {
    const hash = 'rate-test';
    social.chatRates.delete(hash);
    const start = 1000000;
    for (let index = 0; index < social.CHAT_BURST; index++) assert.ok(social.chatRateTake(hash, start));
    assert.ok(!social.chatRateTake(hash, start));
    assert.ok(!social.chatRateTake(hash, start + social.CHAT_REFILL_MS - 1));
    assert.ok(social.chatRateTake(hash, start + social.CHAT_REFILL_MS));
    assert.ok(!social.chatRateTake(hash, start + social.CHAT_REFILL_MS));
});

test('a room keeps the players heard from lately', () => {
    social.rooms.clear();
    social.roomNote('p2p:room', 'AAAA-AAAA', 'One', 0, 0);
    social.roomNote('p2p:room', 'BBBB-BBBB', 'Two', 1, 20000);
    assert.deepStrictEqual(social.roomMembers('p2p:room', 25000).map((member) => member.code), ['AAAA-AAAA', 'BBBB-BBBB']);
    assert.deepStrictEqual(social.roomMembers('p2p:room', social.ROOM_MEMBER_MS + 1).map((member) => member.code),
        ['BBBB-BBBB']);
    assert.deepStrictEqual(social.roomMembers('p2p:room', 20000 + social.ROOM_MEMBER_MS + 1), []);
    assert.ok(!social.rooms.has('p2p:room'));
});

test('settings are taken as sent, each on until set', () => {
    assert.deepStrictEqual(social.parseSettings({ friends: false, join: true, other: false, activity: 'no' }),
        { friends: false, join: true });
    assert.strictEqual(social.parseSettings({}), null);
    assert.strictEqual(social.parseSettings([]), null);
    assert.deepStrictEqual(social.settingsOf({ settings: { requests: false } }),
        { friends: true, requests: false, activity: true, join: true, privateChat: true, privateAnyone: true });
    assert.deepStrictEqual(social.unflatten({ 'settings.friends': false, lastSeenAt: 1 }),
        { settings: { friends: false }, lastSeenAt: 1 });
});

test('another account is known by its public id, its own by its code', () => {
    const id = social.newPublicId();
    assert.match(id, /^p[0-9a-z]{11}$/);
    const account = { keyHash: 'h1', code: 'ABCD-EFGH', publicId: id };
    assert.strictEqual(social.idFor(account, 'h1'), 'ABCD-EFGH');
    assert.strictEqual(social.idFor(account, 'h2'), id);
    assert.deepStrictEqual(social.accountQuery(id), { query: { publicId: id }, byCode: false });
    assert.deepStrictEqual(social.accountQuery('abcdefgh'), { query: { code: 'ABCD-EFGH' }, byCode: true });
    assert.strictEqual(social.accountQuery('nope'), null);
});

test('presence shows what the other lets it', () => {
    const now = Date.now();
    const presence = { state: 'multiplayer', map: 'bloodgulch', invite: 'halo://join/' + 'a'.repeat(64) };
    const other = { lastSeenAt: new Date(now - 1000), presence };
    assert.strictEqual(social.presenceView(other, { now }).online, true);
    assert.strictEqual(social.presenceView(other, { now }).map, 'bloodgulch');
    assert.strictEqual(social.presenceView(other, { now }).invite, undefined);
    assert.strictEqual(social.presenceView(other, { friend: true, now }).invite, presence.invite);
    const away = { ...other, lastSeenAt: new Date(now - social.ONLINE_MS - 1) };
    assert.strictEqual(social.presenceView(away, { friend: true, now }).online, false);
    const hidden = { ...other, settings: { activity: false } };
    assert.deepStrictEqual(social.presenceView(hidden, { friend: true, now }), { online: true });
    const noJoin = { ...other, settings: { join: false } };
    assert.strictEqual(social.presenceView(noJoin, { friend: true, now }).invite, undefined);
    const noFriends = { ...other, settings: { friends: false } };
    assert.deepStrictEqual(social.presenceView(noFriends, { friend: true, now }), { online: false });
    assert.strictEqual(social.parsePresence({ state: 'bogus', invite: 'x y' }).state, 'menus');
    assert.strictEqual(social.parsePresence({ invite: 'x y' }).invite, '');
});

test('a friendship is one pair, whoever asked', () => {
    assert.strictEqual(social.pairKey('b', 'a'), social.pairKey('a', 'b'));
    assert.strictEqual(social.relationOf(null, 'a'), 'none');
    assert.strictEqual(social.relationOf({ state: 'friends' }, 'a'), 'friends');
    assert.strictEqual(social.relationOf({ state: 'pending', requester: 'a' }, 'a'), 'outgoing');
    assert.strictEqual(social.relationOf({ state: 'pending', requester: 'b' }, 'a'), 'incoming');
});
