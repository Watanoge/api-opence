/**
 * Account sync: one account on several installs (routes/routes_social.js).
 *
 * A player makes a sync code on one install (POST /account/sync/code), which
 * the game keeps asking for while its code is shown (every few seconds);
 * the code works only that long: SYNC_CODE_MS after it was last asked for,
 * or once the screen is left (POST /account/sync/cancel), it is no good.
 * The player types it on another install (POST /account/sync/redeem): that
 * install becomes a device of the account (account_links, halo_links.js),
 * and every request with its key is the account's from then on: its friend
 * list, totals, medals and matches, and (halo_sql.js) its leaderboard records.
 * What the install had before is brought into the account: its matches and
 * totals, its friends, those it muted and blocked, and (as the leaderboards
 * are asked for, halo_sql.js) its records. A code is taken once.
 *
 * The account also keeps its skulls (accounts.skulls): how they are unlocked
 * (mode, all, instant, lose) and which are, shared by its devices
 * (POST /account/skulls). Unlocked skulls only add up, from every device;
 * the style is changed by the device that has seen the last one (version),
 * and a reset of the skulls' progress starts a new epoch, which the other
 * devices follow. Nothing else of an install (its profiles, controls,
 * campaign progress, settings) is the server's.
 */
const { collection } = require('./db');
const { ACCOUNT_LINKS, ensureLinkIndexes } = require('./halo_links');
const { internals: social } = require('./halo_social');

const SYNC_CODES = 'sync_codes';

/** a code is good this long after the game last asked for it (the game asks every 15 seconds) */
const SYNC_CODE_MS = 45000;
/** wrong codes allowed from one install in SYNC_TRY_WINDOW_MS */
const SYNC_TRIES = 5;
const SYNC_TRY_WINDOW_MS = 60000;
const SKULLS_MAX = 64;
const SKULL_KEY = /^[a-z0-9_]{1,40}$/;
const STYLE_MODES = new Set(['', 'play']);
const DEFAULT_STYLE = { mode: '', all: false, instant: false, lose: true };

const tries = new Map();
let indexesEnsured = null;

function ensureIndexes() {
    if (!indexesEnsured) {
        indexesEnsured = (async () => {
            await ensureLinkIndexes();
            const codes = await collection(SYNC_CODES);
            await codes.createIndex({ code: 1 }, { unique: true });
            await codes.createIndex({ account: 1 });
            // (a code long dead is swept; its time is checked by lastSeenAt)
            await codes.createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 300 });
        })().catch((err) => {
            indexesEnsured = null;
            throw err;
        });
    }
    return indexesEnsured;
}

// ---------- skulls

/** the skulls' keys as the game sends them (comma separated, or a list): those valid, once each; null for another type */
function parseUnlocked(value) {
    const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : null;
    if (!list) return null;
    const keys = [];
    for (const item of list) {
        const key = typeof item === 'string' ? item.trim() : '';
        if (SKULL_KEY.test(key) && !keys.includes(key)) keys.push(key);
        if (keys.length >= SKULLS_MAX) break;
    }
    return keys;
}

/** how the skulls are unlocked as the game sends it: { mode, all, instant, lose }, null for none */
function parseStyle(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const mode = typeof value.mode === 'string' ? value.mode : null;
    if (mode === null || !STYLE_MODES.has(mode)) return null;
    return {
        mode,
        all: value.all === true,
        instant: value.instant === true,
        lose: value.lose !== false,
    };
}

function sameStyle(a, b) {
    return a.mode === b.mode && a.all === b.all && a.instant === b.instant && a.lose === b.lose;
}

/** the account's skulls (as stored, or none yet) */
function skullsOf(stored) {
    return {
        version: stored?.version || 0,
        epoch: stored?.epoch || 0,
        style: { ...DEFAULT_STYLE, ...(stored?.style || {}) },
        unlocked: Array.isArray(stored?.unlocked) ? stored.unlocked : [],
    };
}

/**
 * the skulls after what a device sent ({ style, unlocked, version, epoch,
 * reset }): its unlocked skulls added; its style taken when it has seen the
 * last one (its version is the account's); a reset starting a new epoch.
 * One of an older epoch is ignored: it has not heard of the reset.
 */
function mergeSkulls(stored, body) {
    const state = skullsOf(stored);
    if (!body || typeof body !== 'object') return state;
    const epoch = Number.isInteger(body.epoch) ? body.epoch : -1;
    // (an epoch of -1, or none: the device has not had one yet, and takes the account's)
    if (epoch >= 0 && epoch !== state.epoch) return state;
    const style = parseStyle(body.style);
    if (body.reset === true) {
        return {
            version: state.version + 1,
            epoch: state.epoch + 1,
            style: style || { ...DEFAULT_STYLE },
            unlocked: [],
        };
    }
    const sent = parseUnlocked(body.unlocked) || [];
    const unlocked = [...state.unlocked];
    for (const key of sent) {
        if (unlocked.length < SKULLS_MAX && !unlocked.includes(key)) unlocked.push(key);
    }
    const seen = Number.isInteger(body.version) && body.version === state.version;
    if (style && seen && !sameStyle(style, state.style)) {
        return { ...state, version: state.version + 1, style, unlocked };
    }
    return { ...state, unlocked };
}

/** the skulls as the game reads them ("unlocked" as comma separated text) */
function publicSkulls(skulls) {
    return {
        version: skulls.version,
        epoch: skulls.epoch,
        style: skulls.style,
        unlocked: skulls.unlocked.join(','),
    };
}

/** the account's skulls changed by what a device sent, kept (a change of its own in between: again) */
async function applySkulls(account, body) {
    const accounts = await collection(social.ACCOUNTS);
    let current = account;
    for (let attempt = 0; attempt < 4; attempt++) {
        const next = mergeSkulls(current.skulls, body);
        const was = skullsOf(current.skulls);
        if (JSON.stringify(next) === JSON.stringify(was)) return next;
        const result = await accounts.updateOne(
            { keyHash: current.keyHash, 'skulls.version': current.skulls?.version ?? { $exists: false } },
            { $set: { skulls: next } },
        );
        if (result.matchedCount) return next;
        current = await accounts.findOne({ keyHash: current.keyHash });
    }
    return skullsOf(current.skulls);
}

async function syncSkulls(key, body) {
    await ensureIndexes();
    const parsedKey = social.accountKey(key);
    if (!parsedKey) return social.error('unauthorized', 401);
    const account = await social.accountOf(parsedKey);
    const sent = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    return { synced: (account.linkedDevices || 0) > 0, skulls: publicSkulls(await applySkulls(account, sent)) };
}

// ---------- codes

/** the account's code, asked for again and again while its screen is open */
async function createSyncCode(key, body, now = Date.now()) {
    await ensureIndexes();
    const parsedKey = social.accountKey(key);
    if (!parsedKey) return social.error('unauthorized', 401);
    const account = await social.accountOf(parsedKey);
    const skulls = await applySkulls(account, body?.skulls);
    const codes = await collection(SYNC_CODES);
    const alive = new Date(now - SYNC_CODE_MS);
    const asked = social.normalizeCode(body?.code);
    if (asked) {
        const kept = await codes.findOneAndUpdate(
            { code: asked, account: account.keyHash, lastSeenAt: { $gte: alive } },
            { $set: { lastSeenAt: new Date(now) } },
        );
        if (kept?.value !== undefined ? kept.value : kept) {
            return { code: asked, expiresIn: SYNC_CODE_MS / 1000, synced: (account.linkedDevices || 0) > 0, skulls: publicSkulls(skulls) };
        }
    }
    // (a new one in place of the account's others)
    await codes.deleteMany({ account: account.keyHash });
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = social.newCode();
        try {
            await codes.insertOne({ code, account: account.keyHash, createdAt: new Date(now), lastSeenAt: new Date(now) });
            return { code, expiresIn: SYNC_CODE_MS / 1000, synced: (account.linkedDevices || 0) > 0, skulls: publicSkulls(skulls) };
        } catch (err) {
            if (err?.code !== 11000) throw err;
        }
    }
    throw new Error('could not draw a sync code');
}

/** the account's code no longer good (its screen was left) */
async function cancelSyncCode(key) {
    await ensureIndexes();
    const parsedKey = social.accountKey(key);
    if (!parsedKey) return social.error('unauthorized', 401);
    const account = await social.accountOf(parsedKey);
    await (await collection(SYNC_CODES)).deleteMany({ account: account.keyHash });
    return {};
}

function triesTake(deviceHash, now) {
    const entry = tries.get(deviceHash);
    if (!entry || now - entry.at > SYNC_TRY_WINDOW_MS) return { at: now, count: 0 };
    return entry;
}

function triesNote(deviceHash, now) {
    const entry = triesTake(deviceHash, now);
    entry.count++;
    tries.set(deviceHash, entry);
    if (tries.size > 20000) {
        for (const [hash, other] of tries) {
            if (now - other.at > SYNC_TRY_WINDOW_MS) tries.delete(hash);
        }
    }
}

// ---------- joining an account

/** the totals and medals of an account, as $inc's fields */
function totalsIncrements(account) {
    const increments = {};
    for (const kind of social.MATCH_KINDS) {
        for (const [field, value] of Object.entries(account.stats?.[kind] || {})) {
            if (Number.isFinite(value) && value) increments[`stats.${kind}.${field}`] = value;
        }
    }
    for (const [medal, value] of Object.entries(account.medals || {})) {
        if (Number.isFinite(value) && value) increments[`medals.${medal}`] = value;
    }
    return increments;
}

/** an account's matches moved to another (one the other has already is dropped, not counted twice) */
async function moveMatches(from, to) {
    const matches = await collection(social.ACCOUNT_MATCHES);
    let duplicates = 0;
    for await (const row of matches.find({ account: from }, { projection: { _id: 1 } })) {
        try {
            await matches.updateOne({ _id: row._id }, { $set: { account: to } });
        } catch (err) {
            if (err?.code !== 11000) throw err;
            await matches.deleteOne({ _id: row._id });
            duplicates++;
        }
    }
    return duplicates;
}

/** an account's friendships, requests included, made the other's (those between them gone) */
async function moveFriendships(from, to) {
    const friendships = await collection(social.FRIENDSHIPS);
    const rows = await friendships.find({ $or: [{ a: from }, { b: from }] }).toArray();
    for (const row of rows) {
        const other = row.a === from ? row.b : row.a;
        if (other === to || other === from) {
            await friendships.deleteOne({ _id: row._id });
            continue;
        }
        const pair = social.pairKey(to, other);
        const existing = await friendships.findOne({ pair });
        if (existing) {
            // (both knew them: friends if either was, or the two asked each other)
            const requester = row.requester === from ? to : row.requester;
            const friends = existing.state === 'friends' || row.state === 'friends' || existing.requester !== requester;
            if (friends && existing.state !== 'friends') {
                await friendships.updateOne({ _id: existing._id }, { $set: { state: 'friends', since: new Date() } });
            }
            await friendships.deleteOne({ _id: row._id });
            continue;
        }
        await friendships.updateOne({ _id: row._id }, {
            $set: { pair, a: to, b: other, requester: row.requester === from ? to : row.requester },
        });
    }
}

/** what others had of an account (blocked, muted, reported) now of the other */
async function moveModeration(from, to, source) {
    const accounts = await collection(social.ACCOUNTS);
    const own = (list) => (list || []).filter((hash) => hash !== to && hash !== from);
    const muted = own(source.muted);
    const blocked = own(source.blocked);
    if (muted.length) await accounts.updateOne({ keyHash: to }, { $addToSet: { muted: { $each: muted } } });
    if (blocked.length) await accounts.updateOne({ keyHash: to }, { $addToSet: { blocked: { $each: blocked } } });
    for (const field of ['muted', 'blocked']) {
        if (await accounts.countDocuments({ [field]: from }, { limit: 1 })) {
            await accounts.updateMany({ [field]: from }, { $addToSet: { [field]: to } });
            await accounts.updateMany({ [field]: from }, { $pull: { [field]: from } });
        }
    }
    const reports = await collection(social.ACCOUNT_REPORTS);
    await reports.deleteMany({ from });
    await reports.deleteMany({ target: from, from: to });
    for await (const row of reports.find({ target: from }, { projection: { _id: 1 } })) {
        try {
            await reports.updateOne({ _id: row._id }, { $set: { target: to } });
        } catch (err) {
            if (err?.code !== 11000) throw err;
            await reports.deleteOne({ _id: row._id });
        }
    }
}

/**
 * (POST /account/sync/redeem) the install joins the account of the code: what
 * it had is brought into it, and its key is the account's from now on
 */
async function redeemSyncCode(key, body, now = Date.now()) {
    await ensureIndexes();
    const parsedKey = social.accountKey(key);
    if (!parsedKey) return social.error('unauthorized', 401);
    const deviceHash = social.hashKey(parsedKey);
    if (triesTake(deviceHash, now).count >= SYNC_TRIES) return social.error('too_many_tries', 429);
    const code = social.normalizeCode(body?.code);
    if (!code) return social.validationError(['code is not a sync code (XXXX-XXXX)']);

    const links = await collection(ACCOUNT_LINKS);
    if (await links.findOne({ device: deviceHash })) return social.error('already_synced', 409);
    const mine = await social.accountOf(parsedKey);
    if ((mine.linkedDevices || 0) > 0) return social.error('already_synced', 409);

    const codes = await collection(SYNC_CODES);
    const alive = new Date(now - SYNC_CODE_MS);
    const found = await codes.findOne({ code, lastSeenAt: { $gte: alive } });
    if (!found) {
        triesNote(deviceHash, now);
        return social.error('invalid_code', 404);
    }
    if (found.account === mine.keyHash) return social.error('same_account', 422);
    // (taken once: two at once, the first has it)
    const taken = await codes.findOneAndDelete({ code, lastSeenAt: { $gte: alive } });
    if (!(taken?.value !== undefined ? taken.value : taken)) {
        triesNote(deviceHash, now);
        return social.error('invalid_code', 404);
    }

    const accounts = await collection(social.ACCOUNTS);
    const target = await accounts.findOne({ keyHash: found.account });
    if (!target) return social.error('invalid_code', 404);
    try {
        await links.insertOne({ device: deviceHash, account: target.keyHash, createdAt: new Date(now) });
    } catch (err) {
        if (err?.code === 11000) return social.error('already_synced', 409);
        throw err;
    }
    await accounts.updateOne({ keyHash: target.keyHash }, { $inc: { linkedDevices: 1 } });

    // (what the install had, brought in; its account gone, as its key is the target's now)
    await moveMatches(mine.keyHash, target.keyHash);
    const increments = totalsIncrements(mine);
    if (Object.keys(increments).length) await accounts.updateOne({ keyHash: target.keyHash }, { $inc: increments });
    if (mine.reports) await accounts.updateOne({ keyHash: target.keyHash }, { $inc: { reports: mine.reports } });
    await moveFriendships(mine.keyHash, target.keyHash);
    await moveModeration(mine.keyHash, target.keyHash, mine);
    if (mine.skulls) await applySkulls(await accounts.findOne({ keyHash: target.keyHash }), {
        unlocked: (mine.skulls.unlocked || []).join(','),
    });
    // (the name picked on either: the account's own first)
    if (!target.displayName && mine.displayName) {
        await accounts.updateOne({ keyHash: target.keyHash }, { $set: {
            displayName: mine.displayName, ...(!target.nameColor && mine.nameColor ? { nameColor: mine.nameColor } : {}),
        } });
    }
    await accounts.deleteOne({ keyHash: mine.keyHash });

    const joined = await accounts.findOne({ keyHash: target.keyHash });
    return { account: social.ownAccount(joined), skulls: publicSkulls(skullsOf(joined.skulls)) };
}

module.exports = {
    internals: {
        SYNC_CODE_MS, SYNC_TRIES, tries, mergeSkulls, parseUnlocked, parseStyle, publicSkulls, skullsOf, totalsIncrements,
    },
    createSyncCode,
    cancelSyncCode,
    redeemSyncCode,
    syncSkulls,
};
