/**
 * The developer portal's management endpoints (database/halo_admin.js), for
 * its page at /admin (public/admin.html). Each asks for x-admin-code:
 * HALO_ADMIN_CODE (none set: all of them off). A machine that gets the code
 * wrong too often is kept out for a while.
 *
 *   GET    /admin/api/overview
 *   GET    /admin/api/days                       ?from=&to= (YYYY-MM-DD)
 *   GET    /admin/api/days/:day
 *   PUT    /admin/api/days/:day                  fields to set; force, clearScores
 *   POST   /admin/api/days/:day/regenerate       force, clearScores
 *   DELETE /admin/api/days/:day                  ?force=true (with its scores)
 *   DELETE /admin/api/days/:day/scores/:player
 *   DELETE /admin/api/days/:day/scores/:player/day-best
 *   GET    /admin/api/levels
 *   GET    /admin/api/levels/:level
 *   DELETE /admin/api/levels/:level/scores/:player (with their runs)
 *   DELETE /admin/api/runs/:id                    (the player's best worked out again)
 *   GET    /admin/api/players                    ?q=
 *   DELETE /admin/api/players/:player             (with everything of theirs)
 */
const crypto = require('crypto');
const express = require('express');
const admin = require('../database/halo_admin');
const { isDatabaseError } = require('../database/db');

const router = express.Router();

const FAILURES_ALLOWED = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failures = new Map();

function codeMatches(given) {
    const code = process.env.HALO_ADMIN_CODE || '';
    if (!code || typeof given !== 'string') return false;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(code).digest();
    return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
    if (!process.env.HALO_ADMIN_CODE) return res.status(403).json({ error: { type: 'admin_off' } });
    const now = Date.now();
    const record = failures.get(req.ip);
    if (record && now - record.since > FAILURE_WINDOW_MS) failures.delete(req.ip);
    else if (record && record.count >= FAILURES_ALLOWED) {
        return res.status(429).json({ error: { type: 'too_many_attempts' } });
    }
    if (!codeMatches(req.get('x-admin-code'))) {
        const current = failures.get(req.ip) || { count: 0, since: now };
        current.count++;
        failures.set(req.ip, current);
        return res.status(403).json({ error: { type: 'forbidden' } });
    }
    failures.delete(req.ip);
    return next();
});

function respond(name, handler) {
    return async (req, res) => {
        try {
            const result = await handler(req);
            if (result?.error) return res.status(result.status || 422).json({ error: result.error });
            return res.status(200).json({ data: result });
        } catch (err) {
            console.error(`admin ${name}:`, err);
            if (isDatabaseError(err)) return res.status(503).json({ error: { type: 'database' } });
            return res.status(500).json({ error: { type: 'internal' } });
        }
    };
}

router.get('/overview', respond('overview', () => admin.getOverview()));

router.get('/days', respond('days', (req) => admin.listDays(req.query)));
router.get('/days/:day', respond('day', (req) => admin.getDay(req.params.day, req.query)));
router.put('/days/:day', respond('set day', (req) => admin.setDay(req.params.day, req.body)));
router.post('/days/:day/regenerate', respond('regenerate day',
    (req) => admin.regenerateDay(req.params.day, req.body)));
router.delete('/days/:day', respond('delete day', (req) => admin.deleteDay(req.params.day, req.query)));
router.delete('/days/:day/scores/:player', respond('delete day score',
    (req) => admin.deleteDayScore(req.params.day, req.params.player)));
router.delete('/days/:day/scores/:player/day-best', respond('clear day best',
    (req) => admin.clearDayBest(req.params.day, req.params.player)));

router.get('/levels', respond('levels', () => admin.listLevels()));
router.get('/levels/:level', respond('level', (req) => admin.getLevel(req.params.level, req.query)));
router.delete('/levels/:level/scores/:player', respond('delete level score',
    (req) => admin.deleteLevelScore(req.params.level, req.params.player)));
router.delete('/runs/:id', respond('delete run', (req) => admin.deleteLevelRun(req.params.id)));

router.get('/players', respond('players', (req) => admin.listPlayers(req.query)));
router.delete('/players/:player', respond('delete player', (req) => admin.deletePlayer(req.params.player)));

module.exports = router;
