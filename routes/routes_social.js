/**
 * Halo CE Universal's social side — accounts, their records and the fork's
 * chat (database/halo_social.js). The game sends its install's key as
 * X-Halo-Key; the account is the install's, whatever its players' names.
 *
 *   POST /account                 the game started: the account, made the first time; {settings}
 *   GET  /account                 the account, its totals, medals and settings
 *   POST /account/setup           {name, color, emblem} the player's first setup
 *   POST /account/emblem          {emblem} its emblem changed
 *   POST /account/rank            {xp, done} its rank raised; {reset: true} cleared, for testing
 *   POST /account/creator         {seed?, add?} what it made: the counts on disk (the first time), or since
 *   POST /account/code            its friend code drawn anew (once a minute at most)
 *   POST /account/sync/code       {code?, skulls?} a sync code for another install, kept alive by asking again (45 seconds)
 *   POST /account/sync/cancel     its sync code no longer good
 *   POST /account/sync/redeem     {code} this install joins the account of the code (its friends, records, skulls)
 *   POST /account/skulls          {style, unlocked, version, epoch, reset} the skulls shared by its installs; answers them
 *   GET  /account/skulls          the skulls shared by its installs
 *   POST /account/matches         a match or a level played
 *   GET  /account/matches         ?limit= the latest
 *   POST /chat/messages           a line: global, match, team or private
 *   GET  /chat/messages           ?after=&room=&team=&global=0&reported=1&name= the lines heard since
 *   POST /presence                what the game is doing; the friends online, the requests waiting
 *   POST /presence/offline        the game closed (the key as X-Halo-Key or as the text body: a tab's beacon)
 *   GET  /friends                 the friends and what they do, the requests to and from it
 *   POST /friends                 {code} asked to be its friend (accepted, when it asked first)
 *   POST /friends/accept          {code} its request accepted
 *   POST /friends/remove          {code} a friend removed, a request declined or taken back
 *   GET  /players/:code           ?matches= a player: totals, medals, presence, latest matches
 *   GET  /activity                ?limit= the friends' latest matches and levels
 *   GET  /moderation              the accounts muted and blocked
 *   POST /moderation              {code, action: mute|unmute|block|unblock|report, reason}
 *
 * Another account is named by its public id (as every answer gives it) or by
 * its friend code (as a player types it: a friend request by it is taken
 * even from an account that takes no others); a chat line's `to` alike.
 */
const express = require('express');
const {
    hello,
    getAccount,
    changeCode,
    setAccountName,
    setupAccount,
    setEmblem,
    setRank,
    addCreator,
    submitMatch,
    getMatches,
    sendChat,
    pollChat,
    setPresence,
    setOffline,
    getFriends,
    requestFriend,
    acceptFriend,
    removeFriend,
    getPlayer,
    getActivity,
    getModeration,
    moderate,
} = require('../database/halo_social');
const { createSyncCode, cancelSyncCode, redeemSyncCode, syncSkulls } = require('../database/halo_sync');
const { isDatabaseError } = require('../database/db');

const router = express.Router();

function accountKey(req) {
    return req.get('x-halo-key');
}

/** a handler's result as JSON: { data } or { error } with its status */
function respond(name, handler) {
    return async (req, res) => {
        try {
            const result = await handler(req);
            if (result?.error) {
                return res.status(result.status || 422).json({ error: result.error });
            }
            return res.status(200).json({ data: result });
        } catch (err) {
            console.error(`${name}:`, err);
            if (isDatabaseError(err)) return res.status(503).json({ error: { type: 'database' } });
            return res.status(500).json({ error: { type: 'internal' } });
        }
    };
}

router.post('/account', respond('POST /account',
    (req) => hello(accountKey(req), req.body)));

router.get('/account', respond('GET /account',
    (req) => getAccount(accountKey(req))));

router.post('/account/code', respond('POST /account/code',
    (req) => changeCode(accountKey(req))));

router.post('/account/name', respond('POST /account/name',
    (req) => setAccountName(accountKey(req), req.body)));

router.post('/account/setup', respond('POST /account/setup',
    (req) => setupAccount(accountKey(req), req.body)));
router.post('/account/emblem', respond('POST /account/emblem',
    (req) => setEmblem(accountKey(req), req.body)));
router.post('/account/rank', respond('POST /account/rank',
    (req) => setRank(accountKey(req), req.body)));
router.post('/account/creator', respond('POST /account/creator',
    (req) => addCreator(accountKey(req), req.body)));
router.post('/account/sync/code', respond('POST /account/sync/code',
    (req) => createSyncCode(accountKey(req), req.body)));

router.post('/account/sync/cancel', respond('POST /account/sync/cancel',
    (req) => cancelSyncCode(accountKey(req))));

router.post('/account/sync/redeem', respond('POST /account/sync/redeem',
    (req) => redeemSyncCode(accountKey(req), req.body)));

router.post('/account/skulls', respond('POST /account/skulls',
    (req) => syncSkulls(accountKey(req), req.body)));

router.get('/account/skulls', respond('GET /account/skulls',
    (req) => syncSkulls(accountKey(req), null)));

router.post('/account/matches', respond('POST /account/matches',
    (req) => submitMatch(accountKey(req), req.body)));

router.get('/account/matches', respond('GET /account/matches',
    (req) => getMatches(accountKey(req), req.query)));

router.post('/chat/messages', respond('POST /chat/messages',
    (req) => sendChat(accountKey(req), req.body)));

router.get('/chat/messages', respond('GET /chat/messages',
    (req) => pollChat(accountKey(req), req.query)));

router.post('/presence', respond('POST /presence',
    (req) => setPresence(accountKey(req), req.body)));

// (a browser's tab closing: navigator.sendBeacon, which sends no headers of
// its own, the key as the text body)
router.post('/presence/offline', express.text({ type: () => true, limit: '1kb' }), respond('POST /presence/offline',
    (req) => setOffline(accountKey(req) || (typeof req.body === 'string' ? req.body : ''))));

router.get('/friends', respond('GET /friends',
    (req) => getFriends(accountKey(req))));

router.post('/friends', respond('POST /friends',
    (req) => requestFriend(accountKey(req), req.body)));

router.post('/friends/accept', respond('POST /friends/accept',
    (req) => acceptFriend(accountKey(req), req.body)));

router.post('/friends/remove', respond('POST /friends/remove',
    (req) => removeFriend(accountKey(req), req.body)));

router.get('/players/:code', respond('GET /players/:code',
    (req) => getPlayer(accountKey(req), req.params.code, req.query)));

router.get('/activity', respond('GET /activity',
    (req) => getActivity(accountKey(req), req.query)));

router.get('/moderation', respond('GET /moderation',
    (req) => getModeration(accountKey(req))));

router.post('/moderation', respond('POST /moderation',
    (req) => moderate(accountKey(req), req.body)));

module.exports = router;
