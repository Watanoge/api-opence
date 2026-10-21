/**
 * Halo CE Universal's online leaderboards and daily challenges.
 *
 * A player is a profile of an install of the game: a random secret key the
 * install makes on first use, with a hash of the profile's name after it (sent
 * as X-Halo-Key, so split screen's players are each their own), kept here only
 * as its SHA-256. The name shown is the profile name the game sends with each
 * score. A run says how many players its game had (co-op's are its players').
 *
 * - level_runs: every campaign level won and sent, as it came
 * - level_bests: each player's best of each level (the most points; its
 *   time, difficulty, skulls and medals with it)
 * - daily_challenges: each day's challenge (utils/halo_daily.js), made the
 *   first time the day is asked for, and never changed once it has scores
 * - daily_scores: each player's best of each day's challenge, taken whenever
 *   it is played; and (dayBest) their best while the day lasted (server time:
 *   HALO_DAILY_TIMEZONE), whose top three the day's leaderboard keeps on top
 */
const crypto = require('crypto');
const { collection } = require('./db');
const daily = require('../utils/halo_daily');

const PLAYERS = 'players';
const LEVEL_RUNS = 'level_runs';
const LEVEL_BESTS = 'level_bests';
const DAILY_CHALLENGES = 'daily_challenges';
const DAILY_SCORES = 'daily_scores';

/** the API's version, which the game checks (and the oldest game it takes) */
const API_VERSION = 1;
const MINIMUM_CLIENT_API = 1;

const NAME_MAX_LEN = 32;
const LEADERBOARD_MAX = 50;
const HISTORY_MAX = 60;
/** the day's best while it lasted, kept on top of its leaderboard */
const DAY_TOP = 3;
/** the shortest time between two scores of one player (a replay of the same win) */
const SUBMIT_INTERVAL_MS = 3000;

const LEVEL_KEYS = new Set(daily.LEVELS.map((level) => level.key));

let indexesEnsured = null;
const lastSubmit = new Map();

function ensureIndexes() {
    if (!indexesEnsured) {
        indexesEnsured = (async () => {
            await (await collection(PLAYERS)).createIndex({ keyHash: 1 }, { unique: true });
            await (await collection(LEVEL_RUNS)).createIndex({ level: 1, submittedAt: -1 });
            await (await collection(LEVEL_BESTS)).createIndex({ level: 1, player: 1 }, { unique: true });
            await (await collection(LEVEL_BESTS)).createIndex({ level: 1, score: -1, seconds: 1 });
            await (await collection(DAILY_CHALLENGES)).createIndex({ day: 1 }, { unique: true });
            await (await collection(DAILY_SCORES)).createIndex({ day: 1, player: 1 }, { unique: true });
            await (await collection(DAILY_SCORES)).createIndex({ day: 1, score: -1, seconds: 1 });
        })().catch((error) => {
            indexesEnsured = null;
            throw error;
        });
    }
    return indexesEnsured;
}

// ---------- validation

function error(type, status, extra = {}) {
    return { error: { type, ...extra }, status };
}

function validationError(errors) {
    return { error: { type: 'validation', errors }, status: 422 };
}

/** the install's key: 32 to 128 letters, digits, - or _ */
function parseKey(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim();
    return /^[A-Za-z0-9_-]{32,128}$/.test(key) ? key : null;
}

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

/** a profile's name: printable, trimmed (the game's are 11 characters) */
function parseName(value) {
    if (typeof value !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX_LEN);
    return name.length ? name : null;
}

function parseInteger(value, minimum, maximum) {
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function parseLimit(value, fallback, maximum) {
    const limit = parseInteger(value, 1, maximum);
    return limit === null ? fallback : limit;
}

/** a run's figures, as the game's campaign_score_record has them */
function parseRun(body) {
    const errors = [];
    const run = {
        score: parseInteger(body?.score, -10000000, 100000000),
        seconds: parseInteger(body?.seconds, 1, 7 * 24 * 3600),
        difficulty: parseInteger(body?.difficulty, 0, 3),
        skulls: parseInteger(body?.skulls ?? 0, 0, 64),
        skullsPercent: parseInteger(body?.skullsPercent ?? 100, 0, 1000000),
        medals: parseInteger(body?.medals ?? 0, 0, 1000000),
        kills: parseInteger(body?.kills ?? 0, 0, 1000000),
        deaths: parseInteger(body?.deaths ?? 0, 0, 1000000),
        // (the game's players: 1 alone, more in co-op, split screen or online)
        players: parseInteger(body?.players ?? 1, 1, 16),
    };
    for (const [field, value] of Object.entries(run)) {
        if (value === null) errors.push(`${field} is missing or out of range`);
    }
    const client = {
        platform: typeof body?.platform === 'string' ? body.platform.slice(0, 32) : undefined,
        build: parseInteger(body?.build ?? 0, 0, 100000000) ?? 0,
    };
    return { errors, run, client };
}

/** the player of the key, made or renamed (its last name is the one shown) */
async function playerOf(key, name) {
    const keyHash = hashKey(key);
    const now = new Date();
    await (await collection(PLAYERS)).updateOne({ keyHash },
        { $set: { name, lastSeenAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
    return keyHash;
}

/** one score a few seconds from the player's last is refused (sent twice) */
function throttled(keyHash) {
    const now = Date.now();
    const last = lastSubmit.get(keyHash) || 0;
    if (now - last < SUBMIT_INTERVAL_MS) return true;
    lastSubmit.set(keyHash, now);
    if (lastSubmit.size > 10000) {
        for (const [hash, time] of lastSubmit) {
            if (now - time > SUBMIT_INTERVAL_MS) lastSubmit.delete(hash);
        }
    }
    return false;
}

/** a's better than b: more points, then less time */
function better(a, b) {
    if (!b) return true;
    if (a.score !== b.score) return a.score > b.score;
    return a.seconds < b.seconds;
}

/** the row as the game shows it (no key's hash beyond an id to tell names apart) */
function publicRow(document, rank) {
    return {
        rank,
        name: document.name,
        id: document.player.slice(0, 8),
        score: document.score,
        seconds: document.seconds,
        difficulty: document.difficulty,
        skulls: document.skulls,
        skullsPercent: document.skullsPercent,
        medals: document.medals,
        players: document.players ?? 1,
        at: document.achievedAt,
    };
}

/** the rows of a collection's board (filter: its level or its day), and the player's own place */
async function board(name, filter, limit, key) {
    const scores = await collection(name);
    const rows = await scores.find(filter).sort({ score: -1, seconds: 1, achievedAt: 1 }).limit(limit).toArray();
    const result = {
        rows: rows.map((row, index) => publicRow(row, index + 1)),
        players: await scores.countDocuments(filter),
    };
    if (key) {
        const mine = await scores.findOne({ ...filter, player: hashKey(key) });
        if (mine) {
            const ahead = await scores.countDocuments({ ...filter, $or: [
                { score: { $gt: mine.score } },
                { score: mine.score, seconds: { $lt: mine.seconds } },
            ] });
            result.me = publicRow(mine, ahead + 1);
        }
    }
    return result;
}

// ---------- status

function getStatus() {
    const timeZone = daily.serverTimeZone();
    const now = new Date();
    const day = daily.dayKeyAt(now, timeZone);
    return {
        ok: true,
        api: API_VERSION,
        minimumClientApi: MINIMUM_CLIENT_API,
        serverTime: now,
        timeZone,
        day,
        dayEndsAt: daily.dayEnd(day, timeZone),
    };
}

// ---------- campaign leaderboards

async function submitLevelScore(key, body) {
    await ensureIndexes();
    const parsedKey = parseKey(key);
    const name = parseName(body?.name);
    const level = typeof body?.level === 'string' ? body.level.trim().toLowerCase() : '';
    const { errors, run, client } = parseRun(body);
    if (!parsedKey) errors.push('X-Halo-Key is missing or malformed');
    if (!name) errors.push('name is required');
    if (!LEVEL_KEYS.has(level)) errors.push('level is not a campaign level');
    if (errors.length) return validationError(errors);

    const player = await playerOf(parsedKey, name);
    if (throttled(player)) return error('too_soon', 429);
    const now = new Date();

    await (await collection(LEVEL_RUNS)).insertOne({ level, player, name, ...run, ...client, submittedAt: now });
    const bests = await collection(LEVEL_BESTS);
    const best = await bests.findOne({ level, player });
    const improved = better(run, best);
    await bests.updateOne({ level, player }, {
        $set: { name, lastRunAt: now, ...(improved ? { ...run, achievedAt: now } : {}) },
        $inc: { runs: 1 },
    }, { upsert: true });

    const standing = await board(LEVEL_BESTS, { level }, 1, parsedKey);
    return { recorded: true, improved, me: standing.me, players: standing.players };
}

async function getLevelLeaderboard(level, query, key) {
    await ensureIndexes();
    const levelKey = typeof level === 'string' ? level.trim().toLowerCase() : '';
    if (!LEVEL_KEYS.has(levelKey)) return error('unknown_level', 404);
    const limit = parseLimit(query?.limit, 10, LEADERBOARD_MAX);
    const result = await board(LEVEL_BESTS, { level: levelKey }, limit, parseKey(key));
    return { level: levelKey, ...result };
}

// ---------- daily challenges

/** what the game is sent of a challenge, and whether it still takes scores */
function publicChallenge(challenge, now = new Date()) {
    const { _id, createdAt, updatedAt, ...rest } = challenge;
    return { ...rest, open: now < new Date(challenge.closesAt), serverTime: now };
}

/** the day's challenge, made now if asked to and there is none yet */
async function challengeOf(day, { create = false } = {}) {
    const challenges = await collection(DAILY_CHALLENGES);
    let challenge = await challenges.findOne({ day });
    if (challenge || !create) return challenge;

    const previous = await challenges.findOne({ day: daily.addDays(day, -1) });
    const generated = daily.generateChallenge(day, { previousLevel: previous?.level ?? null });
    try {
        await challenges.insertOne({ ...generated, createdAt: new Date() });
    } catch (insertError) {
        // (two first askers at once: the unique index keeps one, which both read)
        if (insertError.code !== 11000) throw insertError;
    }
    challenge = await challenges.findOne({ day });
    return challenge;
}

async function getTodayChallenge(key) {
    await ensureIndexes();
    const today = daily.dayKeyAt(new Date());
    const challenge = await challengeOf(today, { create: true });
    if (!challenge) return error('unavailable', 503);
    return withMine(publicChallenge(challenge), key);
}

/** a day's, today's or before; a day to come is not shown */
async function getChallenge(day, key) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const today = daily.dayKeyAt(new Date());
    if (day > today) return error('not_found', 404);
    const challenge = await challengeOf(day, { create: day === today });
    if (!challenge) return error('not_found', 404);
    return withMine(publicChallenge(challenge), key);
}

async function withMine(challenge, key) {
    const parsedKey = parseKey(key);
    if (!parsedKey) return challenge;
    const mine = await (await collection(DAILY_SCORES)).findOne({ day: challenge.day, player: hashKey(parsedKey) });
    return mine ? { ...challenge, mine: { ...publicRow(mine, null), attempts: mine.attempts } } : challenge;
}

/** the days before (and with) `before`, newest first, with how many played and the best score */
async function getChallengeHistory(query, key) {
    await ensureIndexes();
    const today = daily.dayKeyAt(new Date());
    await challengeOf(today, { create: true });
    const before = daily.isDayKey(query?.before) && query.before <= today ? query.before : today;
    const limit = parseLimit(query?.limit, 14, HISTORY_MAX);

    const challenges = await (await collection(DAILY_CHALLENGES)).find({ day: { $lte: before } })
        .sort({ day: -1 }).limit(limit).project({ config: 0 }).toArray();
    const days = challenges.map((challenge) => challenge.day);
    const scores = await collection(DAILY_SCORES);
    const totals = days.length ? await scores.aggregate([
        { $match: { day: { $in: days } } },
        { $sort: { score: -1, seconds: 1 } },
        { $group: { _id: '$day', players: { $sum: 1 }, bestScore: { $first: '$score' }, bestName: { $first: '$name' } } },
    ]).toArray() : [];
    const byDay = Object.fromEntries(totals.map((row) => [row._id, row]));

    // (the key's best of each day, and its place on the day's leaderboard)
    let mine = {};
    const parsedKey = parseKey(key);
    if (parsedKey && days.length) {
        const rows = await scores.find({ player: hashKey(parsedKey), day: { $in: days } }).toArray();
        for (const row of rows) {
            const ahead = await scores.countDocuments({ day: row.day, $or: [
                { score: { $gt: row.score } },
                { score: row.score, seconds: { $lt: row.seconds } },
            ] });
            mine[row.day] = { ...row, rank: ahead + 1 };
        }
    }

    const now = new Date();
    return {
        today,
        days: challenges.map((challenge) => ({
            day: challenge.day,
            level: challenge.level,
            levelTitle: challenge.levelTitle,
            difficulty: challenge.difficulty,
            difficultyName: challenge.difficultyName,
            skulls: challenge.skulls,
            details: challenge.details,
            open: now < new Date(challenge.closesAt),
            closesAt: challenge.closesAt,
            players: byDay[challenge.day]?.players ?? 0,
            bestScore: byDay[challenge.day]?.bestScore ?? null,
            bestName: byDay[challenge.day]?.bestName ?? null,
            mine: mine[challenge.day] ? {
                score: mine[challenge.day].score,
                seconds: mine[challenge.day].seconds,
                rank: mine[challenge.day].rank,
            } : null,
        })),
    };
}

/** the day's top three while it lasted (dayBest), with their place among them */
async function dayTop(day) {
    const rows = await (await collection(DAILY_SCORES)).find({ day, 'dayBest.score': { $exists: true } })
        .sort({ 'dayBest.score': -1, 'dayBest.seconds': 1, 'dayBest.achievedAt': 1 }).limit(DAY_TOP).toArray();
    return rows.map((row, index) => publicRow({ ...row, ...row.dayBest }, index + 1));
}

async function getChallengeLeaderboard(day, query, key) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const challenge = await challengeOf(day);
    if (!challenge || day > daily.dayKeyAt(new Date())) return error('not_found', 404);
    const limit = parseLimit(query?.limit, 10, LEADERBOARD_MAX);
    const result = await board(DAILY_SCORES, { day }, limit, parseKey(key));
    return {
        day,
        open: new Date() < new Date(challenge.closesAt),
        closesAt: challenge.closesAt,
        dayTop: await dayTop(day),
        ...result,
    };
}

/** the settings the game says it played with are the challenge's (skullSet: the skulls' names) */
function settingsMatch(challenge, body) {
    const skulls = Array.isArray(body?.skullSet) ? [...body.skullSet].map(String).sort() : null;
    return body?.level === challenge.level &&
        Number(body?.difficulty) === challenge.difficulty &&
        Number(body?.seed) === challenge.seed &&
        Number(body?.version ?? challenge.version) === challenge.version &&
        skulls !== null && skulls.join(',') === [...challenge.skulls].sort().join(',');
}

async function submitChallengeScore(day, key, body) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const parsedKey = parseKey(key);
    const name = parseName(body?.name);
    const { errors, run, client } = parseRun(body);
    if (!parsedKey) errors.push('X-Halo-Key is missing or malformed');
    if (!name) errors.push('name is required');
    if (errors.length) return validationError(errors);

    const challenge = await challengeOf(day);
    if (!challenge || day > daily.dayKeyAt(new Date())) return error('not_found', 404);
    const now = new Date();
    // (taken whenever it is played; while the day lasts, its day's best too)
    const open = now < new Date(challenge.closesAt);
    if (!settingsMatch(challenge, { ...body, difficulty: run.difficulty })) {
        return error('settings_mismatch', 422);
    }

    const player = await playerOf(parsedKey, name);
    if (throttled(player)) return error('too_soon', 429);
    const scores = await collection(DAILY_SCORES);
    const best = await scores.findOne({ day, player });
    const improved = better(run, best);
    const dayImproved = open && better(run, best?.dayBest);
    await scores.updateOne({ day, player }, {
        $set: {
            name, lastRunAt: now, ...client,
            ...(improved ? { ...run, achievedAt: now } : {}),
            ...(dayImproved ? { dayBest: { ...run, achievedAt: now } } : {}),
        },
        $inc: { attempts: 1 },
    }, { upsert: true });

    const standing = await board(DAILY_SCORES, { day }, 1, parsedKey);
    return { recorded: true, improved, open, me: standing.me, players: standing.players };
}

/**
 * (HALO_ADMIN_CODE) a day's challenge set by hand: a day to come, or one
 * that has no scores yet; the fields given replace the generated ones (the
 * randomizer's, any of them, over its), and its lines and settings follow
 */
async function setChallenge(day, body) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const now = new Date();
    if (now >= daily.dayEnd(day)) return error('closed', 409);
    if (await (await collection(DAILY_SCORES)).countDocuments({ day }) > 0) return error('has_scores', 409);

    const generated = daily.generateChallenge(day, {});
    const given = body && typeof body === 'object' ? body : {};
    const { errors, randomizer } = daily.checkedRandomizer(generated.randomizer, given.randomizer);
    const replacement = { ...generated, ...given, day, randomizer };
    if (!LEVEL_KEYS.has(replacement.level)) errors.push('level is not a campaign level');
    if (!Array.isArray(replacement.skulls)) errors.push('skulls is a list');
    if (errors.length) return validationError(errors);
    replacement.details = daily.challengeDetails(randomizer);
    replacement.config = daily.challengeConfig(randomizer, replacement.skulls);
    const challenges = await collection(DAILY_CHALLENGES);
    await challenges.replaceOne({ day }, { ...replacement, createdAt: now, updatedAt: now }, { upsert: true });
    return publicChallenge(await challengeOf(day));
}

module.exports = {
    // (the developer portal's: database/halo_admin.js)
    internals: {
        PLAYERS, LEVEL_RUNS, LEVEL_BESTS, DAILY_CHALLENGES, DAILY_SCORES, LEVEL_KEYS,
        ensureIndexes, challengeOf, publicChallenge, better, hashKey,
    },
    getStatus,
    submitLevelScore,
    getLevelLeaderboard,
    getTodayChallenge,
    getChallenge,
    getChallengeHistory,
    getChallengeLeaderboard,
    submitChallengeScore,
    setChallenge,
};
