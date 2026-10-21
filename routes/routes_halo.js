/**
 * Halo CE Universal's leaderboards and daily challenges — public endpoints.
 * The game sends its install's key as X-Halo-Key (database/halo_sql.js).
 *
 *   GET  /status
 *   POST /levels/scores                   a campaign level won
 *   GET  /levels/:level/leaderboard       ?limit=
 *   GET  /daily                           today's challenge
 *   GET  /daily/history                   ?before=YYYY-MM-DD&limit=
 *   GET  /daily/:day                      a past day's challenge
 *   GET  /daily/:day/leaderboard          ?limit=
 *   POST /daily/:day/scores               taken until the day ends
 *   PUT  /daily/:day                      x-admin-code: HALO_ADMIN_CODE
 */
const express = require('express');
const {
    getStatus,
    submitLevelScore,
    getLevelLeaderboard,
    getTodayChallenge,
    getChallenge,
    getChallengeHistory,
    getChallengeLeaderboard,
    submitChallengeScore,
    setChallenge,
} = require('../database/halo_sql');
const { databaseReachable, isDatabaseError } = require('../database/db');

const router = express.Router();

function playerKey(req) {
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
            // (the database down is the server's trouble to say: the game
            // offers another server, or offline)
            if (isDatabaseError(err)) return res.status(503).json({ error: { type: 'database' } });
            return res.status(500).json({ error: { type: 'internal' } });
        }
    };
}

router.get('/status', async (_req, res) => {
    const database = await databaseReachable();
    res.status(database ? 200 : 503).json({ data: { ...getStatus(), database: database ? 'ok' : 'unavailable' } });
});

router.post('/levels/scores', respond('POST /levels/scores',
    (req) => submitLevelScore(playerKey(req), req.body)));

router.get('/levels/:level/leaderboard', respond('GET /levels/:level/leaderboard',
    (req) => getLevelLeaderboard(req.params.level, req.query, playerKey(req))));

router.get('/daily', respond('GET /daily',
    (req) => getTodayChallenge(playerKey(req))));

// (before /daily/:day, which would take "history" for a day)
router.get('/daily/history', respond('GET /daily/history',
    (req) => getChallengeHistory(req.query, playerKey(req))));

router.get('/daily/:day', respond('GET /daily/:day',
    (req) => getChallenge(req.params.day, playerKey(req))));

router.get('/daily/:day/leaderboard', respond('GET /daily/:day/leaderboard',
    (req) => getChallengeLeaderboard(req.params.day, req.query, playerKey(req))));

router.post('/daily/:day/scores', respond('POST /daily/:day/scores',
    (req) => submitChallengeScore(req.params.day, playerKey(req), req.body)));

router.put('/daily/:day', respond('PUT /daily/:day', (req) => {
    const code = process.env.HALO_ADMIN_CODE;
    if (!code || req.get('x-admin-code') !== code) {
        return { error: { type: 'forbidden' }, status: 403 };
    }
    return setChallenge(req.params.day, req.body);
}));

module.exports = router;
