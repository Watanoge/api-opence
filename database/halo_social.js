/**
 * Halo CE Universal's social side: accounts, their match records and the
 * fork's chat (routes/routes_social.js).
 *
 * An account is an install of the game, whatever its players' names: its
 * key (X-Halo-Key, the same random secret the leaderboards take, without the
 * profile's part after it) kept here only as its SHA-256, as the
 * leaderboards keep theirs. No one registers: the first request makes it.
 * Each account has a public code (XXXX-XXXX, Crockford's base 32), the name
 * others see beside its name; the name is the one the game last sent.
 *
 * - accounts: the account, its totals (stats.multiplayer, stats.campaign)
 *   and each medal's count (medals.<key>)
 * - account_matches: every match and level the game sent, as it came (a
 *   match sent twice, by its matchId, is taken once)
 * - chat_messages: the fork's chat lines, numbered in order (seq, from
 *   counters' "chat"), kept only CHAT_KEEP_MINUTES (as IRC: no history, a
 *   line is there for the polls that follow it): global ones, a match's (its room,
 *   a key the game makes for the game it is in) and its teams', and private
 *   ones between two accounts
 * - friendships: two accounts (a and b, their pair's key the two hashes in
 *   order), asked for by one of them (requester), pending until the other
 *   accepts
 * - account_reports: an account reported by another, once each
 *
 * An account also keeps its social settings (settings.<field>, SETTING_FIELDS,
 * all on until the game says otherwise), what it is doing (presence: the
 * game's POST /presence, a while apart; online while lastSeenAt is recent),
 * the accounts it muted and blocked (muted, blocked: their hashes) and how
 * many accounts reported it (reports). A line of one muted or blocked, or of
 * one that blocked the listener, is never heard; one of an account reported
 * by REPORTED_HIDE_COUNT accounts or more only when asked for (reported=1).
 *
 * A match's room also knows who is in it: the accounts polling it lately,
 * kept in memory (the private chat's list of players there).
 */
const crypto = require('crypto');
const { collection } = require('./db');

const ACCOUNTS = 'accounts';
const ACCOUNT_MATCHES = 'account_matches';
const CHAT_MESSAGES = 'chat_messages';
const COUNTERS = 'counters';
const FRIENDSHIPS = 'friendships';
const ACCOUNT_REPORTS = 'account_reports';

const NAME_MAX_LEN = 32;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const MATCH_KINDS = new Set(['multiplayer', 'campaign']);
const MATCH_RESULTS = new Set(['win', 'loss', 'tie']);
const MATCH_HISTORY_MAX = 50;
const MEDAL_KEYS_MAX = 64;

const CHAT_CHANNELS = new Set(['global', 'match', 'team', 'private']);
const CHAT_TEXT_MAX = 200;
/** a line is kept this long: long enough for every client's next poll (the
 * game's slowest is 15 seconds, after a failure), then gone (MongoDB's TTL
 * sweep runs about once a minute) */
const CHAT_KEEP_MINUTES = 10;
const CHAT_POLL_MAX = 100;
/** an account's lines: CHAT_BURST at once, another each CHAT_REFILL_MS */
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1500;
/** a room's player, gone when not heard from in this long */
const ROOM_MEMBER_MS = 30000;
const ROOM_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,96}$/;

/** an account's social settings, each on until the game says otherwise:
 * friends (its friend list), requests (others may ask to be its friend),
 * activity (its friends see what it plays), join (its friends may join the
 * game it hosts: its invite), privateChat (private lines reach it) */
const SETTING_FIELDS = ['friends', 'requests', 'activity', 'join', 'privateChat'];
/** an account is online while it was heard from this lately (the game's
 * presence comes every 45 seconds, its chat's polls more often) */
const ONLINE_MS = 120000;
const PRESENCE_STATES = new Set(['menus', 'campaign', 'multiplayer', 'theater']);
const INVITE_MAX_LEN = 160;
const FRIENDS_MAX = 200;
const MODERATION_MAX = 500;
const REPORT_REASON_MAX = 120;
/** a player's lines are hidden (unless asked for) once this many accounts reported it */
const REPORTED_HIDE_COUNT = 3;
const ACTIVITY_MAX = 50;
const PLAYER_MATCHES_MAX = 20;
const MODERATION_ACTIONS = new Set(['mute', 'unmute', 'block', 'unblock', 'report']);

let indexesEnsured = null;

/** the lines' TTL index, made again when an older server made it with another expiry (14 days) */
async function ensureChatExpiry(messages) {
    const expireAfterSeconds = CHAT_KEEP_MINUTES * 60;
    try {
        await messages.createIndex({ at: 1 }, { expireAfterSeconds });
    } catch (err) {
        // (IndexOptionsConflict, or IndexKeySpecsConflict: the same key, another expiry)
        if (err?.code !== 85 && err?.code !== 86) throw err;
        await messages.dropIndex('at_1');
        await messages.createIndex({ at: 1 }, { expireAfterSeconds });
    }
}
const chatRates = new Map();
const rooms = new Map();

function ensureIndexes() {
    if (!indexesEnsured) {
        indexesEnsured = (async () => {
            const accounts = await collection(ACCOUNTS);
            await accounts.createIndex({ keyHash: 1 }, { unique: true });
            await accounts.createIndex({ code: 1 }, { unique: true });
            const matches = await collection(ACCOUNT_MATCHES);
            await matches.createIndex({ account: 1, matchId: 1 }, { unique: true });
            await matches.createIndex({ account: 1, playedAt: -1 });
            const messages = await collection(CHAT_MESSAGES);
            await messages.createIndex({ seq: 1 }, { unique: true });
            await messages.createIndex({ channel: 1, seq: 1 });
            await messages.createIndex({ room: 1, seq: 1 });
            await messages.createIndex({ toHash: 1, seq: 1 });
            await messages.createIndex({ fromHash: 1, seq: 1 });
            await ensureChatExpiry(messages);
            await accounts.createIndex({ blocked: 1 });
            const friendships = await collection(FRIENDSHIPS);
            await friendships.createIndex({ pair: 1 }, { unique: true });
            await friendships.createIndex({ a: 1 });
            await friendships.createIndex({ b: 1 });
            const reports = await collection(ACCOUNT_REPORTS);
            await reports.createIndex({ from: 1, target: 1 }, { unique: true });
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

/**
 * the account's key: the install's (64 hex digits, community_net.c), the
 * part before a profile's ("-" and up to 16 letters or digits) when the game
 * sent one; any other key the leaderboards take is its own account
 */
function accountKey(value) {
    if (typeof value !== 'string') return null;
    const key = value.trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) return null;
    const install = /^([0-9a-f]{64})-[A-Za-z0-9]{1,16}$/.exec(key);
    return install ? install[1] : key;
}

function hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
}

/** a player's name: printable, trimmed (the game's are 11 characters) */
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

/** a short text of the game's (a map's, a gametype's): printable, trimmed */
function parseLabel(value, maximum) {
    if (typeof value !== 'string') return '';
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maximum);
}

/** a code as it is typed: its letters and digits, capitals, O as 0, I and L as 1 */
function normalizeCode(value) {
    if (typeof value !== 'string') return null;
    const code = value.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    if (code.length !== CODE_LENGTH || [...code].some((c) => !CODE_ALPHABET.includes(c))) return null;
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function newCode() {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    let code = '';
    for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** a medal's counts as the game sends them: { key: count }, keys the game's (campaign_medals.c) */
function parseMedals(value, errors) {
    const medals = {};
    if (value === undefined || value === null) return medals;
    if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push('medals must be an object');
        return medals;
    }
    const entries = Object.entries(value);
    if (entries.length > MEDAL_KEYS_MAX) errors.push('too many medals');
    for (const [key, count] of entries.slice(0, MEDAL_KEYS_MAX)) {
        const number = parseInteger(count, 0, 10000);
        if (!/^[a-z0-9_]{1,40}$/.test(key) || number === null) {
            errors.push(`medal ${key} is not valid`);
        } else if (number > 0) {
            medals[key] = number;
        }
    }
    return medals;
}

/** a match or a level as the game sends it (social.c) */
function parseMatch(body) {
    const errors = [];
    const kind = body?.kind;
    if (!MATCH_KINDS.has(kind)) errors.push('kind must be multiplayer or campaign');
    const matchId = typeof body?.matchId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.matchId) ? body.matchId : null;
    if (!matchId) errors.push('matchId is required');
    const result = body?.result === undefined || body?.result === null ? null : body.result;
    if (result !== null && !MATCH_RESULTS.has(result)) errors.push('result must be win, loss or tie');
    const figures = {
        score: parseInteger(body?.score ?? 0, -10000000, 100000000),
        kills: parseInteger(body?.kills ?? 0, 0, 100000),
        deaths: parseInteger(body?.deaths ?? 0, 0, 100000),
        assists: parseInteger(body?.assists ?? 0, 0, 100000),
        suicides: parseInteger(body?.suicides ?? 0, 0, 100000),
        betrayals: parseInteger(body?.betrayals ?? 0, 0, 100000),
        seconds: parseInteger(body?.seconds ?? 0, 0, 7 * 24 * 3600),
        players: parseInteger(body?.players ?? 1, 1, 128),
        place: parseInteger(body?.place ?? 0, 0, 128),
        difficulty: parseInteger(body?.difficulty ?? 0, 0, 3),
    };
    for (const [field, value] of Object.entries(figures)) {
        if (value === null) errors.push(`${field} is not valid`);
    }
    const medals = parseMedals(body?.medals, errors);
    return {
        errors,
        match: {
            matchId,
            kind,
            result,
            ...figures,
            teams: body?.teams === true,
            network: parseLabel(body?.network, 16),
            map: parseLabel(body?.map, 64),
            gametype: parseLabel(body?.gametype, 48),
            medals,
            name: parseName(body?.name),
        },
        client: {
            platform: typeof body?.platform === 'string' ? body.platform.slice(0, 32) : undefined,
            build: parseInteger(body?.build ?? 0, 0, 100000000) ?? 0,
        },
    };
}

/** the totals a match adds to its kind's ($inc's fields) */
function matchIncrements(match) {
    const prefix = `stats.${match.kind}`;
    const increments = {
        [`${prefix}.matches`]: 1,
        [`${prefix}.score`]: match.score,
        [`${prefix}.kills`]: match.kills,
        [`${prefix}.deaths`]: match.deaths,
        [`${prefix}.assists`]: match.assists,
        [`${prefix}.suicides`]: match.suicides,
        [`${prefix}.betrayals`]: match.betrayals,
        [`${prefix}.seconds`]: match.seconds,
    };
    if (match.result === 'win') increments[`${prefix}.wins`] = 1;
    else if (match.result === 'loss') increments[`${prefix}.losses`] = 1;
    else if (match.result === 'tie') increments[`${prefix}.ties`] = 1;
    for (const [key, count] of Object.entries(match.medals)) {
        increments[`medals.${key}`] = count;
        increments[`${prefix}.medals`] = (increments[`${prefix}.medals`] || 0) + count;
    }
    return increments;
}

/** a kind's totals as the game reads them (zeros for none) */
function publicTotals(totals = {}) {
    const fields = ['matches', 'wins', 'losses', 'ties', 'score', 'kills', 'deaths', 'assists', 'suicides',
        'betrayals', 'seconds', 'medals'];
    return Object.fromEntries(fields.map((field) => [field, totals[field] || 0]));
}

function publicAccount(account) {
    return {
        code: account.code,
        name: account.name || null,
        createdAt: account.createdAt,
        stats: {
            multiplayer: publicTotals(account.stats?.multiplayer),
            campaign: publicTotals(account.stats?.campaign),
        },
        medals: account.medals || {},
    };
}

/** the settings as the game sends them ({ field: true|false }, those it has), null for none */
function parseSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const settings = {};
    for (const field of SETTING_FIELDS) {
        if (typeof value[field] === 'boolean') settings[field] = value[field];
    }
    return Object.keys(settings).length ? settings : null;
}

/** an account's settings, each one it never set on */
function settingsOf(account) {
    return Object.fromEntries(SETTING_FIELDS.map((field) => [field, account?.settings?.[field] !== false]));
}

/** an account as the game shows its own: its totals, and its settings */
function ownAccount(account) {
    return { ...publicAccount(account), settings: settingsOf(account) };
}

// ---------- accounts

/** the account of the key: made the first time (with a code of its own), its name and client noted */
async function accountOf(key, { name = null, client = {}, create = true, extra = {} } = {}) {
    const keyHash = hashKey(key);
    const accounts = await collection(ACCOUNTS);
    const now = new Date();
    const set = { lastSeenAt: now, ...extra };
    if (name) set.name = name;
    if (client.platform) set.platform = client.platform;
    if (client.build) set.build = client.build;
    const existing = await accounts.findOneAndUpdate({ keyHash }, { $set: set }, { returnDocument: 'after' });
    const found = existing && Object.prototype.hasOwnProperty.call(existing, 'value') ? existing.value : existing;
    if (found || !create) return found || null;
    // (a new account: its code drawn again in the rare case another has it)
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const account = { keyHash, code: newCode(), ...unflatten(set), createdAt: now, stats: {}, medals: {} };
            await accounts.insertOne(account);
            return account;
        } catch (err) {
            if (err?.code !== 11000) throw err;
            // (two first requests at once: the other made it)
            const made = await accounts.findOne({ keyHash });
            if (made) return made;
        }
    }
    throw new Error('could not make an account code');
}

/** $set's dotted fields ("settings.friends") as the object they make, for a new document */
function unflatten(set) {
    const document = {};
    for (const [path, value] of Object.entries(set)) {
        const parts = path.split('.');
        let at = document;
        for (const part of parts.slice(0, -1)) at = at[part] = at[part] || {};
        at[parts[parts.length - 1]] = value;
    }
    return document;
}

/** the settings sent as $set's fields */
function settingsSet(settings) {
    return settings ? Object.fromEntries(Object.entries(settings).map(([field, on]) => [`settings.${field}`, on])) : {};
}

async function hello(key, body) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const account = await accountOf(parsedKey, {
        name: parseName(body?.name),
        client: {
            platform: typeof body?.platform === 'string' ? body.platform.slice(0, 32) : undefined,
            build: parseInteger(body?.build ?? 0, 0, 100000000) ?? 0,
        },
        extra: settingsSet(parseSettings(body?.settings)),
    });
    return { account: ownAccount(account) };
}

async function getAccount(key) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    return { account: ownAccount(await accountOf(parsedKey)) };
}

async function submitMatch(key, body) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const { errors, match, client } = parseMatch(body);
    if (errors.length) return validationError(errors);
    const account = await accountOf(parsedKey, { name: match.name, client });
    const now = new Date();
    try {
        await (await collection(ACCOUNT_MATCHES)).insertOne({
            account: account.keyHash, ...match, ...client, playedAt: now,
        });
    } catch (err) {
        // (sent again: taken once)
        if (err?.code === 11000) return { account: publicAccount(account), duplicate: true };
        throw err;
    }
    const accounts = await collection(ACCOUNTS);
    await accounts.updateOne({ keyHash: account.keyHash }, { $inc: matchIncrements(match) });
    return { account: publicAccount(await accounts.findOne({ keyHash: account.keyHash })), duplicate: false };
}

async function getMatches(key, query) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const limit = parseLimit(query?.limit, 20, MATCH_HISTORY_MAX);
    const rows = await (await collection(ACCOUNT_MATCHES)).find({ account: hashKey(parsedKey) })
        .sort({ playedAt: -1 }).limit(limit).toArray();
    return {
        matches: rows.map(({ _id, account, ...row }) => row),
    };
}

// ---------- chat

/** an account's lines allowed: CHAT_BURST at once, refilled one each CHAT_REFILL_MS */
function chatRateTake(keyHash, now = Date.now()) {
    const bucket = chatRates.get(keyHash) || { tokens: CHAT_BURST, at: now };
    const refilled = Math.floor((now - bucket.at) / CHAT_REFILL_MS);
    if (refilled > 0) {
        bucket.tokens = Math.min(CHAT_BURST, bucket.tokens + refilled);
        bucket.at = bucket.tokens === CHAT_BURST ? now : bucket.at + refilled * CHAT_REFILL_MS;
    }
    chatRates.set(keyHash, bucket);
    if (chatRates.size > 20000) {
        for (const [hash, other] of chatRates) {
            if (now - other.at > CHAT_BURST * CHAT_REFILL_MS) chatRates.delete(hash);
        }
    }
    if (bucket.tokens <= 0) return false;
    bucket.tokens--;
    return true;
}

/** a line's text: printable, trimmed, at most CHAT_TEXT_MAX characters; null for none */
function parseChatText(value) {
    if (typeof value !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_TEXT_MAX);
    return text.length ? text : null;
}

function parseRoom(value) {
    return typeof value === 'string' && ROOM_KEY_PATTERN.test(value) ? value : null;
}

/** a room's players, as polls note them (the account's code, name and team) */
function roomNote(room, code, name, team, now = Date.now(), keyHash = null) {
    let members = rooms.get(room);
    if (!members) {
        members = new Map();
        rooms.set(room, members);
    }
    members.set(code, { code, name, team, at: now, keyHash });
}

function roomMembers(room, now = Date.now()) {
    const members = rooms.get(room);
    if (!members) return [];
    for (const [code, member] of members) {
        if (now - member.at > ROOM_MEMBER_MS) members.delete(code);
    }
    if (!members.size) {
        rooms.delete(room);
        return [];
    }
    return [...members.values()].map(({ code, name, team, keyHash }) => ({ code, name, team, keyHash }));
}

/** a room's player one never hears (its lines, so not as one to write to) */
function unheardCodes(member, unheard) {
    return member.keyHash && unheard.includes(member.keyHash);
}

/** the next line's number */
async function nextSeq() {
    const counters = await collection(COUNTERS);
    const result = await counters.findOneAndUpdate({ _id: 'chat' }, { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' });
    const counter = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
    return counter.seq;
}

function hasHash(list, keyHash) {
    return Array.isArray(list) && list.includes(keyHash);
}

/** the accounts whose lines an account never hears: those it muted or
 * blocked, and those that blocked it */
async function unheardOf(account) {
    const blockedBy = await (await collection(ACCOUNTS)).find({ blocked: account.keyHash },
        { projection: { keyHash: 1 } }).toArray();
    return [...new Set([...(account.muted || []), ...(account.blocked || []), ...blockedBy.map((other) => other.keyHash)])];
}

/** of these senders, those reported by REPORTED_HIDE_COUNT accounts or more */
async function reportedAmong(hashes) {
    if (!hashes.length) return new Set();
    const rows = await (await collection(ACCOUNTS)).find({ keyHash: { $in: hashes }, reports: { $gte: REPORTED_HIDE_COUNT } },
        { projection: { keyHash: 1 } }).toArray();
    return new Set(rows.map((row) => row.keyHash));
}

function publicMessage(message) {
    return {
        id: message.seq,
        channel: message.channel,
        ...(message.room ? { room: message.room } : {}),
        ...(message.team !== undefined && message.team !== null ? { team: message.team } : {}),
        from: message.from,
        name: message.name,
        ...(message.to ? { to: message.to, toName: message.toName } : {}),
        text: message.text,
        at: message.at,
        ...(message.reported ? { reported: true } : {}),
    };
}

async function sendChat(key, body) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const errors = [];
    const channel = body?.channel;
    if (!CHAT_CHANNELS.has(channel)) errors.push('channel must be global, match, team or private');
    const text = parseChatText(body?.text);
    if (!text) errors.push('text is required');
    const room = parseRoom(body?.room);
    if ((channel === 'match' || channel === 'team') && !room) errors.push('room is required');
    const team = parseInteger(body?.team, 0, 15);
    if (channel === 'team' && team === null) errors.push('team is required');
    const toCode = channel === 'private' ? normalizeCode(body?.to) : null;
    if (channel === 'private' && !toCode) errors.push('to is required');
    if (errors.length) return validationError(errors);

    const account = await accountOf(parsedKey, { name: parseName(body?.name) });
    if (!chatRateTake(account.keyHash)) return error('rate_limited', 429);
    const message = {
        channel,
        fromHash: account.keyHash,
        from: account.code,
        name: account.name || account.code,
        text,
        at: new Date(),
    };
    if (channel === 'match' || channel === 'team') message.room = room;
    if (channel === 'team') message.team = team;
    if (channel === 'private') {
        const recipient = await (await collection(ACCOUNTS)).findOne({ code: toCode });
        if (!recipient) return error('no_player', 404);
        // (one either blocked, or that takes no private lines, hears none)
        if (hasHash(account.blocked, recipient.keyHash)) return error('blocked', 403);
        if (hasHash(recipient.blocked, account.keyHash)) return error('unavailable', 403);
        if (!settingsOf(recipient).privateChat) return error('private_off', 403);
        message.toHash = recipient.keyHash;
        message.to = recipient.code;
        message.toName = recipient.name || recipient.code;
    }
    message.seq = await nextSeq();
    await (await collection(CHAT_MESSAGES)).insertOne(message);
    return { message: publicMessage(message) };
}

/**
 * the lines an account hears after a line's number (after: 0 or none, none:
 * only where they end, so that nothing said before is heard): global ones (unless global is
 * 0), the room's, its team's (with team), and its private ones (unless its
 * privateChat is off); and the room's players. Never those of accounts it
 * muted or blocked or that blocked it; those of accounts reported by
 * REPORTED_HIDE_COUNT or more only with reported=1 (marked reported)
 */
async function pollChat(key, query) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const account = await accountOf(parsedKey, { name: parseName(query?.name) });
    const room = parseRoom(query?.room);
    const team = parseInteger(query?.team, 0, 15);
    const after = parseInteger(query?.after ?? 0, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const heard = [];
    if (settingsOf(account).privateChat) {
        heard.push({ channel: 'private', toHash: account.keyHash }, { channel: 'private', fromHash: account.keyHash });
    }
    if (query?.global !== '0') heard.push({ channel: 'global' });
    if (room) {
        heard.push({ channel: 'match', room });
        if (team !== null) heard.push({ channel: 'team', room, team });
        roomNote(room, account.code, account.name || account.code, team, Date.now(), account.keyHash);
    }
    const messages = await collection(CHAT_MESSAGES);
    const unheard = await unheardOf(account);
    const filter = { $or: heard.length ? heard : [{ channel: 'none' }] };
    if (unheard.length) filter.fromHash = { $nin: unheard };
    let rows;
    if (after > 0) {
        rows = await messages.find({ seq: { $gt: after }, ...filter }).sort({ seq: 1 }).limit(CHAT_POLL_MAX)
            .toArray();
    } else {
        rows = [];
    }
    let cursor = after;
    if (rows.length) {
        cursor = rows[rows.length - 1].seq;
    } else if (after === 0) {
        const last = await messages.find({}).sort({ seq: -1 }).limit(1).toArray();
        cursor = last.length ? last[0].seq : 0;
    }
    // (the cursor past them all, the lines of reported players hidden or marked)
    const reported = await reportedAmong([...new Set(rows.map((row) => row.fromHash))]
        .filter((hash) => hash !== account.keyHash));
    const showReported = query?.reported === '1';
    rows = rows.filter((row) => showReported || !reported.has(row.fromHash))
        .map((row) => (reported.has(row.fromHash) ? { ...row, reported: true } : row));
    return {
        me: account.code,
        cursor,
        messages: rows.map(publicMessage),
        members: room ? roomMembers(room).filter((member) => !unheardCodes(member, unheard))
            .map(({ keyHash, ...member }) => member) : [],
    };
}

// ---------- presence

/** what the game says it is doing: where (PRESENCE_STATES), the map, the
 * gametype, the game's name and players, and the invite of the game it hosts
 * (its friends may join it: kept only while join is on) */
function parsePresence(body) {
    const state = PRESENCE_STATES.has(body?.state) ? body.state : 'menus';
    const invite = typeof body?.invite === 'string' ? body.invite.trim() : '';
    return {
        state,
        map: parseLabel(body?.map, 64),
        gametype: parseLabel(body?.gametype, 48),
        game: parseLabel(body?.game, 48),
        players: parseInteger(body?.players ?? 0, 0, 128) ?? 0,
        maximum: parseInteger(body?.maximum ?? 0, 0, 128) ?? 0,
        host: body?.host === true,
        invite: /^[\x21-\x7e]{8,160}$/.test(invite) && invite.length <= INVITE_MAX_LEN ? invite : '',
    };
}

function online(account, now = Date.now()) {
    return Boolean(account?.lastSeenAt) && now - new Date(account.lastSeenAt).getTime() < ONLINE_MS;
}

/**
 * another account as a viewer sees it: online (its friend list on: else
 * never), and what it is doing (its activity on), its invite to a friend (its
 * join on, a game it hosts)
 */
function presenceView(other, { friend = false, now = Date.now() } = {}) {
    const settings = settingsOf(other);
    const view = { online: settings.friends && online(other, now) };
    if (view.online && settings.activity && other.presence) {
        const { state, map, gametype, game, players, maximum, host, invite } = other.presence;
        Object.assign(view, { state, map, gametype, game, players, maximum, host });
        if (friend && settings.join && invite) view.invite = invite;
    }
    if (!view.online && settings.activity && settings.friends && other.lastSeenAt) view.lastSeenAt = other.lastSeenAt;
    return view;
}

/** (POST /presence, every 45 seconds or so) what the game is doing; the friends online and the requests waiting */
async function setPresence(key, body) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const account = await accountOf(parsedKey, { name: parseName(body?.name) });
    const presence = { ...parsePresence(body), at: new Date() };
    if (!settingsOf(account).join) presence.invite = '';
    await (await collection(ACCOUNTS)).updateOne({ keyHash: account.keyHash }, { $set: { presence } });
    const { friends, incoming } = await friendshipsOf(account);
    const others = await accountsByHash(friends.map((row) => otherHash(row, account.keyHash)));
    return {
        friendsOnline: others.filter((other) => presenceView(other).online).length,
        requests: incoming.length,
    };
}

// ---------- friends

function pairKey(one, other) {
    return one < other ? `${one}:${other}` : `${other}:${one}`;
}

function otherHash(friendship, keyHash) {
    return friendship.a === keyHash ? friendship.b : friendship.a;
}

async function accountsByHash(hashes) {
    if (!hashes.length) return [];
    return (await collection(ACCOUNTS)).find({ keyHash: { $in: hashes } }).toArray();
}

/** an account's friendships: its friends', and the requests to it and from it */
async function friendshipsOf(account) {
    const rows = await (await collection(FRIENDSHIPS)).find({ $or: [{ a: account.keyHash }, { b: account.keyHash }] })
        .toArray();
    return {
        friends: rows.filter((row) => row.state === 'friends'),
        incoming: rows.filter((row) => row.state === 'pending' && row.requester !== account.keyHash),
        outgoing: rows.filter((row) => row.state === 'pending' && row.requester === account.keyHash),
    };
}

async function friendshipOf(account, other) {
    return (await collection(FRIENDSHIPS)).findOne({ pair: pairKey(account.keyHash, other.keyHash) });
}

/** what one account is to another: friend, incoming (asked to be its), outgoing (it asked), none */
function relationOf(friendship, keyHash) {
    if (!friendship) return 'none';
    if (friendship.state === 'friends') return 'friends';
    return friendship.requester === keyHash ? 'outgoing' : 'incoming';
}

function playerName(account) {
    return account.name || account.code;
}

/** the account's friends (online first, then by name) with what they do, and the requests to and from it */
async function getFriends(key) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const account = await accountOf(parsedKey);
    const { friends, incoming, outgoing } = await friendshipsOf(account);
    const others = new Map((await accountsByHash([...friends, ...incoming, ...outgoing]
        .map((row) => otherHash(row, account.keyHash)))).map((other) => [other.keyHash, other]));
    const now = Date.now();
    const list = (rows, shape) => rows.map((row) => [row, others.get(otherHash(row, account.keyHash))])
        .filter(([, other]) => other).map(([row, other]) => shape(row, other));
    const friendList = list(friends, (row, other) => ({
        code: other.code, name: playerName(other), since: row.since || row.at,
        ...presenceView(other, { friend: true, now }),
    }));
    friendList.sort((one, other) => (other.online - one.online) || one.name.localeCompare(other.name));
    return {
        enabled: settingsOf(account).friends,
        friends: friendList,
        incoming: list(incoming, (row, other) => ({ code: other.code, name: playerName(other), at: row.at })),
        outgoing: list(outgoing, (row, other) => ({ code: other.code, name: playerName(other), at: row.at })),
    };
}

/** the account and another by its code (body.code, or a code given): errors for none, itself */
async function accountAndOther(key, code) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return { failed: error('unauthorized', 401) };
    const otherCode = normalizeCode(code);
    if (!otherCode) return { failed: validationError(['code is not valid']) };
    const account = await accountOf(parsedKey);
    const other = await (await collection(ACCOUNTS)).findOne({ code: otherCode });
    // (no_player, not not_found: the game tells it from a route this server lacks)
    if (!other) return { failed: error('no_player', 404) };
    if (other.keyHash === account.keyHash) return { account, other, self: true };
    return { account, other };
}

/** (POST /friends) a request to be another's friend (accepted at once when it asked first) */
async function requestFriend(key, body) {
    const { failed, account, other, self } = await accountAndOther(key, body?.code);
    if (failed) return failed;
    if (self) return validationError(['that is your own code']);
    if (hasHash(account.blocked, other.keyHash)) return error('blocked', 403);
    if (hasHash(other.blocked, account.keyHash)) return error('unavailable', 403);
    if (!settingsOf(account).friends) return error('friends_off', 403);
    const friendships = await collection(FRIENDSHIPS);
    const existing = await friendshipOf(account, other);
    const player = { code: other.code, name: playerName(other) };
    if (existing?.state === 'friends') return { state: 'friends', player };
    if (existing && existing.requester !== account.keyHash) {
        await friendships.updateOne({ _id: existing._id }, { $set: { state: 'friends', since: new Date() } });
        return { state: 'friends', player };
    }
    if (existing) return { state: 'outgoing', player };
    const otherSettings = settingsOf(other);
    if (!otherSettings.friends || !otherSettings.requests) return error('not_accepting', 403);
    const { friends, outgoing } = await friendshipsOf(account);
    if (friends.length + outgoing.length >= FRIENDS_MAX) return error('too_many', 422);
    try {
        await friendships.insertOne({
            pair: pairKey(account.keyHash, other.keyHash), a: account.keyHash, b: other.keyHash,
            requester: account.keyHash, state: 'pending', at: new Date(),
        });
    } catch (err) {
        if (err?.code !== 11000) throw err;
    }
    return { state: 'outgoing', player };
}

/** (POST /friends/accept) another's request accepted */
async function acceptFriend(key, body) {
    const { failed, account, other, self } = await accountAndOther(key, body?.code);
    if (failed) return failed;
    if (self) return validationError(['that is your own code']);
    const existing = await friendshipOf(account, other);
    if (!existing || existing.requester === account.keyHash) return error('no_request', 404);
    if (existing.state !== 'friends') {
        await (await collection(FRIENDSHIPS)).updateOne({ _id: existing._id },
            { $set: { state: 'friends', since: new Date() } });
    }
    return { state: 'friends', player: { code: other.code, name: playerName(other) } };
}

/** (POST /friends/remove) a friend removed, a request declined or taken back */
async function removeFriend(key, body) {
    const { failed, account, other, self } = await accountAndOther(key, body?.code);
    if (failed) return failed;
    if (self) return validationError(['that is your own code']);
    await (await collection(FRIENDSHIPS)).deleteOne({ pair: pairKey(account.keyHash, other.keyHash) });
    return { state: 'none', player: { code: other.code, name: playerName(other) } };
}

// ---------- players and activity

/** a match as others see it */
function publicMatch(row) {
    const { _id, account, platform, build, matchId, ...match } = row;
    return match;
}

/** (GET /players/:code) a player: its totals and medals, what it is doing,
 * its latest matches (its activity on, or its own), and what it is to the
 * one asking (friend, muted, blocked) */
async function getPlayer(key, code, query) {
    const { failed, account, other, self } = await accountAndOther(key, code);
    if (failed) return failed;
    const friendship = self ? null : await friendshipOf(account, other);
    const relation = self ? 'self' : relationOf(friendship, account.keyHash);
    const settings = settingsOf(other);
    const limit = parseLimit(query?.matches, 10, PLAYER_MATCHES_MAX);
    const shown = self || (settings.activity && !hasHash(other.blocked, account.keyHash));
    const matches = shown ? await (await collection(ACCOUNT_MATCHES)).find({ account: other.keyHash })
        .sort({ playedAt: -1 }).limit(limit).toArray() : [];
    return {
        player: {
            ...publicAccount(other),
            ...(self ? { online: true } : presenceView(other, { friend: relation === 'friends' })),
            relation,
            muted: hasHash(account.muted, other.keyHash),
            blocked: hasHash(account.blocked, other.keyHash),
            requests: settings.friends && settings.requests,
        },
        matches: matches.map(publicMatch),
    };
}

/** (GET /activity) the friends' latest matches and levels (those whose activity is on) */
async function getActivity(key, query) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const account = await accountOf(parsedKey);
    const { friends } = await friendshipsOf(account);
    const others = (await accountsByHash(friends.map((row) => otherHash(row, account.keyHash))))
        .filter((other) => settingsOf(other).activity && settingsOf(other).friends);
    if (!others.length) return { activity: [] };
    const byHash = new Map(others.map((other) => [other.keyHash, other]));
    const rows = await (await collection(ACCOUNT_MATCHES)).find({ account: { $in: [...byHash.keys()] } })
        .sort({ playedAt: -1 }).limit(parseLimit(query?.limit, 30, ACTIVITY_MAX)).toArray();
    return {
        activity: rows.map((row) => ({
            code: byHash.get(row.account).code, player: playerName(byHash.get(row.account)), ...publicMatch(row),
        })),
    };
}

// ---------- moderation

/** (GET /moderation) the accounts muted and blocked */
async function getModeration(key) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const account = await accountOf(parsedKey);
    const shape = (others) => others.map((other) => ({ code: other.code, name: playerName(other) }))
        .sort((one, other) => one.name.localeCompare(other.name));
    return {
        muted: shape(await accountsByHash(account.muted || [])),
        blocked: shape(await accountsByHash(account.blocked || [])),
    };
}

/**
 * (POST /moderation) another account muted (its lines never heard) or not,
 * blocked (neither hears the other, no private lines or friend requests
 * either way, their friendship ended) or not, or reported (once: muted too,
 * and REPORTED_HIDE_COUNT accounts' reports hide its lines from those who
 * did not ask for them)
 */
async function moderate(key, body) {
    const action = body?.action;
    if (!MODERATION_ACTIONS.has(action)) return validationError(['action must be mute, unmute, block, unblock or report']);
    const { failed, account, other, self } = await accountAndOther(key, body?.code);
    if (failed) return failed;
    if (self) return validationError(['that is your own code']);
    const accounts = await collection(ACCOUNTS);
    const listed = (field) => (account[field] || []).length >= MODERATION_MAX && !hasHash(account[field], other.keyHash);
    let duplicate = false;
    if (action === 'mute' || action === 'report') {
        if (listed('muted')) return error('too_many', 422);
        await accounts.updateOne({ keyHash: account.keyHash }, { $addToSet: { muted: other.keyHash } });
    }
    if (action === 'unmute') await accounts.updateOne({ keyHash: account.keyHash }, { $pull: { muted: other.keyHash } });
    if (action === 'block') {
        if (listed('blocked')) return error('too_many', 422);
        await accounts.updateOne({ keyHash: account.keyHash }, { $addToSet: { blocked: other.keyHash } });
        await (await collection(FRIENDSHIPS)).deleteOne({ pair: pairKey(account.keyHash, other.keyHash) });
    }
    if (action === 'unblock') {
        await accounts.updateOne({ keyHash: account.keyHash }, { $pull: { blocked: other.keyHash } });
    }
    if (action === 'report') {
        try {
            await (await collection(ACCOUNT_REPORTS)).insertOne({
                from: account.keyHash, target: other.keyHash, reason: parseLabel(body?.reason, REPORT_REASON_MAX),
                at: new Date(),
            });
            await accounts.updateOne({ keyHash: other.keyHash }, { $inc: { reports: 1 } });
        } catch (err) {
            if (err?.code !== 11000) throw err;
            duplicate = true;
        }
    }
    const updated = await accounts.findOne({ keyHash: account.keyHash });
    return {
        player: { code: other.code, name: playerName(other) },
        muted: hasHash(updated.muted, other.keyHash),
        blocked: hasHash(updated.blocked, other.keyHash),
        ...(action === 'report' ? { reported: true, duplicate } : {}),
    };
}

module.exports = {
    internals: {
        ACCOUNTS, ACCOUNT_MATCHES, CHAT_MESSAGES, CHAT_BURST, CHAT_REFILL_MS, ROOM_MEMBER_MS,
        accountKey, hashKey, normalizeCode, newCode, parseMatch, matchIncrements, publicTotals, parseChatText,
        parseRoom, chatRateTake, roomNote, roomMembers, chatRates, rooms, REPORTED_HIDE_COUNT, ONLINE_MS,
        parseSettings, settingsOf, unflatten, parsePresence, presenceView, pairKey, relationOf,
    },
    hello,
    getAccount,
    submitMatch,
    getMatches,
    sendChat,
    pollChat,
    setPresence,
    getFriends,
    requestFriend,
    acceptFriend,
    removeFriend,
    getPlayer,
    getActivity,
    getModeration,
    moderate,
};
