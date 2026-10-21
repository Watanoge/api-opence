/**
 * The developer portal's management (routes/routes_admin.js, HALO_ADMIN_CODE):
 * the daily challenges of any day, before, today's or to come, set by hand,
 * made again or taken away; and the leaderboards' scores, the levels' and
 * the days', looked at and taken away (a cheat's, a test's).
 *
 * Unlike the game's endpoints, it shows every field of what is kept,
 * players' key hashes (never the keys, which are not kept) included.
 */
const { ObjectId } = require('mongodb');
const { collection } = require('./db');
const daily = require('../utils/halo_daily');
const { internals } = require('./halo_sql');

const {
    PLAYERS, LEVEL_RUNS, LEVEL_BESTS, DAILY_CHALLENGES, DAILY_SCORES, LEVEL_KEYS,
    ensureIndexes, challengeOf, better,
} = internals;

/** every skull the game has (the generator's, and IRON, which it leaves out) */
const ALL_SKULLS = [...Object.keys(daily.SKULL_WEIGHTS), 'iron'].sort();
const DAYS_MAX = 120;
const ROWS_MAX = 500;
/** a challenge's fields that a score's settings are checked against */
const SCORED_FIELDS = ['level', 'difficulty', 'seed', 'skulls', 'version'];
/** and those its scores were played with that are not sent back with them */
const PLAYED_FIELDS = [...SCORED_FIELDS, 'randomizer'];

function error(type, status, extra = {}) {
    return { error: { type, ...extra }, status };
}

function validationError(errors) {
    return { error: { type: 'validation', errors }, status: 422 };
}

function today() {
    return daily.dayKeyAt(new Date());
}

function limitOf(value, fallback, maximum) {
    const limit = Number(value);
    return Number.isInteger(limit) && limit >= 1 ? Math.min(limit, maximum) : fallback;
}

function when(day, now = today()) {
    if (day < now) return 'past';
    return day === now ? 'today' : 'future';
}

/** a challenge as kept, without Mongo's id (its randomizer, from its settings if kept before it had one) */
function challengeRow(challenge) {
    if (!challenge) return null;
    const { _id, ...rest } = challenge;
    return { ...rest, randomizer: rest.randomizer ?? daily.randomizerFromConfig(rest.config) };
}

/** a score as kept (every field), its player's hash beside its short id */
function scoreRow(document, rank) {
    const { _id, ...rest } = document;
    return { rank, id: document.player.slice(0, 8), ...rest };
}

// ---------- the overview

async function getOverview() {
    await ensureIndexes();
    const [players, levelRuns, levelBests, challenges, dailyScores] = await Promise.all(
        [PLAYERS, LEVEL_RUNS, LEVEL_BESTS, DAILY_CHALLENGES, DAILY_SCORES].map(async (name) =>
            (await collection(name)).estimatedDocumentCount()));
    const recentRuns = await (await collection(LEVEL_RUNS)).find({}).sort({ submittedAt: -1 }).limit(10).toArray();
    const recentDaily = await (await collection(DAILY_SCORES)).find({}).sort({ lastRunAt: -1 }).limit(10).toArray();
    return {
        today: today(),
        timeZone: daily.serverTimeZone(),
        adminSetup: Boolean(process.env.HALO_ADMIN_CODE),
        counts: { players, levelRuns, levelBests, challenges, dailyScores },
        recentRuns: recentRuns.map((run) => ({ ...scoreRow(run, null), _id: String(run._id) })),
        recentDaily: recentDaily.map((row) => scoreRow(row, null)),
        levels: daily.LEVELS,
        difficulties: daily.DIFFICULTIES,
        skulls: ALL_SKULLS,
        randomizer: daily.RANDOMIZER_GROUPS,
    };
}

// ---------- the daily challenges

/** the days from `from` to `to` (at most DAYS_MAX), each its challenge (or none yet) and scores */
async function listDays(query) {
    await ensureIndexes();
    const now = today();
    const from = daily.isDayKey(query?.from) ? query.from : daily.addDays(now, -14);
    let to = daily.isDayKey(query?.to) ? query.to : daily.addDays(now, 14);
    if (to < from) return validationError(['to is before from']);
    if (daily.addDays(from, DAYS_MAX - 1) < to) to = daily.addDays(from, DAYS_MAX - 1);

    const challenges = await (await collection(DAILY_CHALLENGES)).find({ day: { $gte: from, $lte: to } })
        .project({ config: 0 }).toArray();
    const byDay = Object.fromEntries(challenges.map((challenge) => [challenge.day, challenge]));
    const totals = await (await collection(DAILY_SCORES)).aggregate([
        { $match: { day: { $gte: from, $lte: to } } },
        { $sort: { score: -1, seconds: 1 } },
        { $group: {
            _id: '$day', players: { $sum: 1 }, attempts: { $sum: '$attempts' },
            bestScore: { $first: '$score' }, bestName: { $first: '$name' },
        } },
    ]).toArray();
    const scoresByDay = Object.fromEntries(totals.map((row) => [row._id, row]));

    const days = [];
    for (let day = to; day >= from; day = daily.addDays(day, -1)) {
        const challenge = byDay[day];
        const scores = scoresByDay[day];
        days.push({
            day,
            when: when(day, now),
            set: Boolean(challenge),
            level: challenge?.level ?? null,
            levelTitle: challenge?.levelTitle ?? null,
            difficulty: challenge?.difficulty ?? null,
            difficultyName: challenge?.difficultyName ?? null,
            skulls: challenge?.skulls ?? [],
            details: challenge?.details ?? [],
            players: scores?.players ?? 0,
            attempts: scores?.attempts ?? 0,
            bestScore: scores?.bestScore ?? null,
            bestName: scores?.bestName ?? null,
        });
    }
    return { today: now, from, to, days };
}

async function getDay(day, query) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const challenge = await challengeOf(day);
    const limit = limitOf(query?.limit, 200, ROWS_MAX);
    const scores = await (await collection(DAILY_SCORES)).find({ day })
        .sort({ score: -1, seconds: 1, achievedAt: 1 }).limit(limit).toArray();
    const players = await (await collection(DAILY_SCORES)).countDocuments({ day });
    return {
        day,
        when: when(day),
        opensAt: daily.dayStart(day),
        closesAt: daily.dayEnd(day),
        challenge: challengeRow(challenge),
        players,
        scores: scores.map((row, index) => scoreRow(row, index + 1)),
    };
}

/**
 * a challenge's derived fields from its own: the level's title, the
 * difficulty's name, the lines the game shows and the settings it is sent
 */
function normalized(challenge) {
    const level = daily.LEVELS.find((entry) => entry.key === challenge.level);
    const skulls = [...new Set(challenge.skulls)].sort();
    return {
        ...challenge,
        levelTitle: level ? level.title : challenge.levelTitle,
        difficultyName: daily.DIFFICULTIES[challenge.difficulty],
        skulls,
        details: daily.challengeDetails(challenge.randomizer),
        config: daily.challengeConfig(challenge.randomizer, skulls),
        opensAt: daily.dayStart(challenge.day),
        closesAt: daily.dayEnd(challenge.day),
        timeZone: daily.serverTimeZone(),
    };
}

/** the fields given, checked, over the challenge they change (only those named) */
function edited(base, body) {
    const errors = [];
    const next = { ...base };
    if (body.level !== undefined) {
        if (!LEVEL_KEYS.has(body.level)) errors.push('level is not a campaign level');
        else next.level = body.level;
    }
    if (body.difficulty !== undefined) {
        const difficulty = Number(body.difficulty);
        if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 3) errors.push('difficulty is 0 to 3');
        else next.difficulty = difficulty;
    }
    if (body.seed !== undefined) {
        const seed = Number(body.seed);
        if (!Number.isInteger(seed) || seed < 1 || seed > 0xFFFFFFFF) errors.push('seed is 1 to 4294967295');
        else next.seed = seed;
    }
    if (body.version !== undefined) {
        const version = Number(body.version);
        if (!Number.isInteger(version) || version < 1 || version > daily.CHALLENGE_VERSION) {
            errors.push(`version is 1 to ${daily.CHALLENGE_VERSION} (the games' own)`);
        } else next.version = version;
    }
    if (body.skulls !== undefined) {
        if (!Array.isArray(body.skulls)) errors.push('skulls is a list');
        else {
            const unknown = body.skulls.filter((skull) => !ALL_SKULLS.includes(skull));
            if (unknown.length) errors.push(`unknown skulls: ${unknown.join(', ')}`);
            else next.skulls = body.skulls;
        }
    }
    const randomizer = daily.checkedRandomizer(base.randomizer, body.randomizer);
    errors.push(...randomizer.errors);
    next.randomizer = randomizer.randomizer;
    return { errors, next };
}

/** what of the challenge its scores were played with changes (its scores no longer its own) */
function scoredChanges(before, after) {
    if (!before) return [];
    return PLAYED_FIELDS.filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

/**
 * a day's challenge set: the fields given over the one it has (or a new one
 * generated). One that has scores is changed only with force, and those of
 * its scores the change makes another's are taken away with clearScores
 */
async function setDay(day, body) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const challenges = await collection(DAILY_CHALLENGES);
    const current = challengeRow(await challenges.findOne({ day }));
    const base = current ?? daily.generateChallenge(day, {
        previousLevel: (await challenges.findOne({ day: daily.addDays(day, -1) }))?.level ?? null,
    });
    const { errors, next } = edited(base, body || {});
    if (errors.length) return validationError(errors);
    return store(day, current, normalized(next), body || {});
}

/** a day's challenge made again at random (not the level of the day before or after) */
async function regenerateDay(day, body) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const challenges = await collection(DAILY_CHALLENGES);
    const current = challengeRow(await challenges.findOne({ day }));
    const previous = await challenges.findOne({ day: daily.addDays(day, -1) });
    const following = await challenges.findOne({ day: daily.addDays(day, 1) });
    let generated;
    do {
        generated = daily.generateChallenge(day, { previousLevel: previous?.level ?? null });
    } while (following && generated.level === following.level);
    return store(day, current, generated, body || {});
}

async function store(day, current, next, options) {
    const scores = await collection(DAILY_SCORES);
    const count = await scores.countDocuments({ day });
    const changes = scoredChanges(current, next);
    if (count && changes.length && !options.force) {
        return error('has_scores', 409, { players: count, changes });
    }
    const now = new Date();
    const challenges = await collection(DAILY_CHALLENGES);
    await challenges.replaceOne({ day }, {
        ...next, day, createdAt: current?.createdAt ?? now, updatedAt: now,
    }, { upsert: true });
    let removed = 0;
    if (count && changes.length && options.clearScores) {
        removed = (await scores.deleteMany({ day })).deletedCount;
    }
    return { ...(await getDay(day)), changes, scoresRemoved: removed };
}

/** a day's challenge taken away (made again, at random, the next time it is asked for, if it is today) */
async function deleteDay(day, query) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const scores = await collection(DAILY_SCORES);
    const count = await scores.countDocuments({ day });
    if (count && query?.force !== 'true') return error('has_scores', 409, { players: count });
    const deleted = (await (await collection(DAILY_CHALLENGES)).deleteOne({ day })).deletedCount;
    const removed = count ? (await scores.deleteMany({ day })).deletedCount : 0;
    if (!deleted) return error('not_found', 404);
    return { day, deleted: true, scoresRemoved: removed };
}

/** one player's score of the day taken away (player: its key's hash, or its first characters) */
async function deleteDayScore(day, player) {
    await ensureIndexes();
    if (!daily.isDayKey(day)) return error('invalid_day', 422);
    const filter = playerFilter(player);
    if (!filter) return error('invalid_player', 422);
    const scores = await collection(DAILY_SCORES);
    const matches = await scores.find({ day, ...filter }).limit(2).toArray();
    if (matches.length !== 1) return error(matches.length ? 'ambiguous_player' : 'not_found', matches.length ? 409 : 404);
    await scores.deleteOne({ _id: matches[0]._id });
    return { day, player: matches[0].player, deleted: true };
}

/** the day's top three while it lasted (dayBest) taken from one player, their best kept */
async function clearDayBest(day, player) {
    await ensureIndexes();
    const filter = playerFilter(player);
    if (!daily.isDayKey(day) || !filter) return error('invalid', 422);
    const result = await (await collection(DAILY_SCORES)).updateOne({ day, ...filter }, { $unset: { dayBest: '' } });
    if (!result.matchedCount) return error('not_found', 404);
    return { day, cleared: true };
}

function playerFilter(player) {
    if (typeof player !== 'string' || !/^[0-9a-f]{8,64}$/.test(player)) return null;
    return player.length === 64 ? { player } : { player: { $regex: `^${player}` } };
}

// ---------- the campaign's leaderboards

async function listLevels() {
    await ensureIndexes();
    const bests = await (await collection(LEVEL_BESTS)).aggregate([
        { $sort: { score: -1, seconds: 1 } },
        { $group: {
            _id: '$level', players: { $sum: 1 }, runs: { $sum: '$runs' },
            bestScore: { $first: '$score' }, bestName: { $first: '$name' }, bestSeconds: { $first: '$seconds' },
            lastRunAt: { $max: '$lastRunAt' },
        } },
    ]).toArray();
    const byLevel = Object.fromEntries(bests.map((row) => [row._id, row]));
    return {
        levels: daily.LEVELS.map((level) => ({
            ...level,
            players: byLevel[level.key]?.players ?? 0,
            runs: byLevel[level.key]?.runs ?? 0,
            bestScore: byLevel[level.key]?.bestScore ?? null,
            bestName: byLevel[level.key]?.bestName ?? null,
            bestSeconds: byLevel[level.key]?.bestSeconds ?? null,
            lastRunAt: byLevel[level.key]?.lastRunAt ?? null,
        })),
    };
}

async function getLevel(level, query) {
    await ensureIndexes();
    if (!LEVEL_KEYS.has(level)) return error('unknown_level', 404);
    const limit = limitOf(query?.limit, 200, ROWS_MAX);
    const bests = await (await collection(LEVEL_BESTS)).find({ level })
        .sort({ score: -1, seconds: 1, achievedAt: 1 }).limit(limit).toArray();
    const runs = await (await collection(LEVEL_RUNS)).find({ level }).sort({ submittedAt: -1 }).limit(limit).toArray();
    return {
        level,
        levelTitle: daily.LEVELS.find((entry) => entry.key === level).title,
        players: await (await collection(LEVEL_BESTS)).countDocuments({ level }),
        bests: bests.map((row, index) => scoreRow(row, index + 1)),
        runs: runs.map((run) => ({ ...scoreRow(run, null), _id: String(run._id) })),
    };
}

/** a player's best of the level taken away, with their runs of it */
async function deleteLevelScore(level, player) {
    await ensureIndexes();
    if (!LEVEL_KEYS.has(level)) return error('unknown_level', 404);
    const filter = playerFilter(player);
    if (!filter) return error('invalid_player', 422);
    const bests = await collection(LEVEL_BESTS);
    const matches = await bests.find({ level, ...filter }).limit(2).toArray();
    if (matches.length !== 1) return error(matches.length ? 'ambiguous_player' : 'not_found', matches.length ? 409 : 404);
    await bests.deleteOne({ _id: matches[0]._id });
    const runs = (await (await collection(LEVEL_RUNS)).deleteMany({ level, player: matches[0].player })).deletedCount;
    return { level, player: matches[0].player, deleted: true, runsRemoved: runs };
}

/** one run taken away, and its player's best of the level worked out again from the runs left */
async function deleteLevelRun(id) {
    await ensureIndexes();
    if (!ObjectId.isValid(id)) return error('invalid_run', 422);
    const runs = await collection(LEVEL_RUNS);
    const run = await runs.findOne({ _id: new ObjectId(id) });
    if (!run) return error('not_found', 404);
    await runs.deleteOne({ _id: run._id });

    const bests = await collection(LEVEL_BESTS);
    const left = await runs.find({ level: run.level, player: run.player }).toArray();
    if (!left.length) {
        await bests.deleteOne({ level: run.level, player: run.player });
        return { deleted: true, best: null };
    }
    let best = null;
    for (const candidate of left) {
        if (better(candidate, best)) best = candidate;
    }
    const fields = ['score', 'seconds', 'difficulty', 'skulls', 'skullsPercent', 'medals', 'kills', 'deaths', 'players'];
    await bests.updateOne({ level: run.level, player: run.player }, {
        $set: {
            ...Object.fromEntries(fields.map((field) => [field, best[field]])),
            achievedAt: best.submittedAt,
            runs: left.length,
        },
    });
    return { deleted: true, best: { score: best.score, seconds: best.seconds } };
}

// ---------- the players

async function listPlayers(query) {
    await ensureIndexes();
    const limit = limitOf(query?.limit, 100, ROWS_MAX);
    const filter = {};
    if (typeof query?.q === 'string' && query.q.trim()) {
        const text = query.q.trim();
        filter.$or = [
            { name: { $regex: text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
            ...(/^[0-9a-f]{4,64}$/.test(text) ? [{ keyHash: { $regex: `^${text}` } }] : []),
        ];
    }
    const players = await (await collection(PLAYERS)).find(filter).sort({ lastSeenAt: -1 }).limit(limit).toArray();
    const hashes = players.map((player) => player.keyHash);
    const count = async (name) => Object.fromEntries((await (await collection(name)).aggregate([
        { $match: { player: { $in: hashes } } },
        { $group: { _id: '$player', count: { $sum: 1 } } },
    ]).toArray()).map((row) => [row._id, row.count]));
    const [levels, days] = await Promise.all([count(LEVEL_BESTS), count(DAILY_SCORES)]);
    return {
        players: players.map(({ _id, ...player }) => ({
            ...player,
            id: player.keyHash.slice(0, 8),
            levels: levels[player.keyHash] ?? 0,
            days: days[player.keyHash] ?? 0,
        })),
    };
}

/** every score of a player taken away (and the player, with everything) */
async function deletePlayer(player) {
    await ensureIndexes();
    if (typeof player !== 'string' || !/^[0-9a-f]{64}$/.test(player)) return error('invalid_player', 422);
    const removed = {};
    for (const [name, field] of [[LEVEL_RUNS, 'player'], [LEVEL_BESTS, 'player'], [DAILY_SCORES, 'player'],
        [PLAYERS, 'keyHash']]) {
        removed[name] = (await (await collection(name)).deleteMany({ [field]: player })).deletedCount;
    }
    return { player, removed };
}

module.exports = {
    ALL_SKULLS,
    getOverview,
    listDays,
    getDay,
    setDay,
    regenerateDay,
    deleteDay,
    deleteDayScore,
    clearDayBest,
    listLevels,
    getLevel,
    deleteLevelScore,
    deleteLevelRun,
    listPlayers,
    deletePlayer,
};
