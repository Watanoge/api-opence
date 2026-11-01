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

test('totals read zero where none was kept', () => {
    assert.deepStrictEqual(social.publicTotals({ kills: 3 }), {
        matches: 0, wins: 0, losses: 0, ties: 0, score: 0, kills: 3, deaths: 0, assists: 0, suicides: 0,
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
