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
 *   counters' "chat"), kept CHAT_KEEP_DAYS: global ones, a match's (its room,
 *   a key the game makes for the game it is in) and its teams', and private
 *   ones between two accounts
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

const NAME_MAX_LEN = 32;
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const MATCH_KINDS = new Set(['multiplayer', 'campaign']);
const MATCH_RESULTS = new Set(['win', 'loss', 'tie']);
const MATCH_HISTORY_MAX = 50;
const MEDAL_KEYS_MAX = 64;

const CHAT_CHANNELS = new Set(['global', 'match', 'team', 'private']);
const CHAT_TEXT_MAX = 200;
const CHAT_KEEP_DAYS = 14;
/** the lines a first poll gets of what was said before it */
const CHAT_BACKLOG = 30;
const CHAT_POLL_MAX = 100;
/** an account's lines: CHAT_BURST at once, another each CHAT_REFILL_MS */
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1500;
/** a room's player, gone when not heard from in this long */
const ROOM_MEMBER_MS = 30000;
const ROOM_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,96}$/;

let indexesEnsured = null;
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
            await messages.createIndex({ at: 1 }, { expireAfterSeconds: CHAT_KEEP_DAYS * 86400 });
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

// ---------- accounts

/** the account of the key: made the first time (with a code of its own), its name and client noted */
async function accountOf(key, { name = null, client = {}, create = true } = {}) {
    const keyHash = hashKey(key);
    const accounts = await collection(ACCOUNTS);
    const now = new Date();
    const set = { lastSeenAt: now };
    if (name) set.name = name;
    if (client.platform) set.platform = client.platform;
    if (client.build) set.build = client.build;
    const existing = await accounts.findOneAndUpdate({ keyHash }, { $set: set }, { returnDocument: 'after' });
    const found = existing && Object.prototype.hasOwnProperty.call(existing, 'value') ? existing.value : existing;
    if (found || !create) return found || null;
    // (a new account: its code drawn again in the rare case another has it)
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const account = { keyHash, code: newCode(), ...set, createdAt: now, stats: {}, medals: {} };
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
    });
    return { account: publicAccount(account) };
}

async function getAccount(key) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    return { account: publicAccount(await accountOf(parsedKey)) };
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
function roomNote(room, code, name, team, now = Date.now()) {
    let members = rooms.get(room);
    if (!members) {
        members = new Map();
        rooms.set(room, members);
    }
    members.set(code, { code, name, team, at: now });
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
    return [...members.values()].map(({ code, name, team }) => ({ code, name, team }));
}

/** the next line's number */
async function nextSeq() {
    const counters = await collection(COUNTERS);
    const result = await counters.findOneAndUpdate({ _id: 'chat' }, { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' });
    const counter = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
    return counter.seq;
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
        if (!recipient) return error('not_found', 404);
        message.toHash = recipient.keyHash;
        message.to = recipient.code;
        message.toName = recipient.name || recipient.code;
    }
    message.seq = await nextSeq();
    await (await collection(CHAT_MESSAGES)).insertOne(message);
    return { message: publicMessage(message) };
}

/**
 * the lines an account hears after a line's number (after: 0 or none, the
 * last CHAT_BACKLOG said and where they end): global ones (unless global is
 * 0), the room's, its team's (with team), and its private ones; and the
 * room's players
 */
async function pollChat(key, query) {
    await ensureIndexes();
    const parsedKey = accountKey(key);
    if (!parsedKey) return error('unauthorized', 401);
    const account = await accountOf(parsedKey, { name: parseName(query?.name) });
    const room = parseRoom(query?.room);
    const team = parseInteger(query?.team, 0, 15);
    const after = parseInteger(query?.after ?? 0, 0, Number.MAX_SAFE_INTEGER) ?? 0;
    const heard = [
        { channel: 'private', toHash: account.keyHash },
        { channel: 'private', fromHash: account.keyHash },
    ];
    if (query?.global !== '0') heard.push({ channel: 'global' });
    if (room) {
        heard.push({ channel: 'match', room });
        if (team !== null) heard.push({ channel: 'team', room, team });
        roomNote(room, account.code, account.name || account.code, team);
    }
    const messages = await collection(CHAT_MESSAGES);
    let rows;
    if (after > 0) {
        rows = await messages.find({ seq: { $gt: after }, $or: heard }).sort({ seq: 1 }).limit(CHAT_POLL_MAX)
            .toArray();
    } else {
        rows = (await messages.find({ $or: heard }).sort({ seq: -1 }).limit(CHAT_BACKLOG).toArray()).reverse();
    }
    let cursor = after;
    if (rows.length) {
        cursor = rows[rows.length - 1].seq;
    } else if (after === 0) {
        const last = await messages.find({}).sort({ seq: -1 }).limit(1).toArray();
        cursor = last.length ? last[0].seq : 0;
    }
    return {
        me: account.code,
        cursor,
        messages: rows.map(publicMessage),
        members: room ? roomMembers(room) : [],
    };
}

module.exports = {
    internals: {
        ACCOUNTS, ACCOUNT_MATCHES, CHAT_MESSAGES, CHAT_BURST, CHAT_REFILL_MS, ROOM_MEMBER_MS,
        accountKey, hashKey, normalizeCode, newCode, parseMatch, matchIncrements, publicTotals, parseChatText,
        parseRoom, chatRateTake, roomNote, roomMembers, chatRates, rooms,
    },
    hello,
    getAccount,
    submitMatch,
    getMatches,
    sendChat,
    pollChat,
};
