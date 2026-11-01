/**
 * Halo CE Universal's social side — accounts, their records and the fork's
 * chat (database/halo_social.js). The game sends its install's key as
 * X-Halo-Key; the account is the install's, whatever its players' names.
 *
 *   POST /account                 the game started: the account, made the first time
 *   GET  /account                 the account, its totals and medals
 *   POST /account/matches         a match or a level played
 *   GET  /account/matches         ?limit= the latest
 *   POST /chat/messages           a line: global, match, team or private
 *   GET  /chat/messages           ?after=&room=&team=&global=0&name= the lines heard since
 */
const express = require('express');
const {
    hello,
    getAccount,
    submitMatch,
    getMatches,
    sendChat,
    pollChat,
} = require('../database/halo_social');
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

router.post('/account/matches', respond('POST /account/matches',
    (req) => submitMatch(accountKey(req), req.body)));

router.get('/account/matches', respond('GET /account/matches',
    (req) => getMatches(accountKey(req), req.query)));

router.post('/chat/messages', respond('POST /chat/messages',
    (req) => sendChat(accountKey(req), req.body)));

router.get('/chat/messages', respond('GET /chat/messages',
    (req) => pollChat(accountKey(req), req.query)));

module.exports = router;
