/**
 * Halo CE Universal daily challenges: the server's day, and a day's challenge
 * generated at random. Pure functions (no database): database/halo_sql.js
 * stores what generateChallenge returns, so a day's challenge never changes
 * once someone has seen it.
 *
 * The challenge's `config` is a set of the game's own settings
 * (port/linux/src/port_config.c's "section.key" names, values as text), which
 * the game applies for the run without writing them to config.toml. Every
 * randomizer and skulls setting is given, so nothing of the player's own
 * setup leaks into a challenge.
 */
const crypto = require('crypto');

/** the campaign's levels, in order (the game's scenario names' last part) */
const LEVELS = [
    { key: 'a10', title: 'The Pillar of Autumn' },
    { key: 'a30', title: 'Halo' },
    { key: 'a50', title: 'Truth and Reconciliation' },
    { key: 'b30', title: 'The Silent Cartographer' },
    { key: 'b40', title: 'Assault on the Control Room' },
    { key: 'c10', title: '343 Guilty Spark' },
    { key: 'c20', title: 'The Library' },
    { key: 'c40', title: 'Two Betrayals' },
    { key: 'd20', title: 'Keyes' },
    { key: 'd40', title: 'The Maw' },
];

const DIFFICULTIES = ['EASY', 'NORMAL', 'HEROIC', 'LEGENDARY'];

/**
 * the skulls a challenge may turn on (port/linux/game/skulls.c's keys), each
 * with its weight; those left out would make a scored run pointless or
 * unfinishable for most players (IRON restarts the whole level on a death)
 */
const SKULL_WEIGHTS = {
    anger: 3, armistice: 1, assassins: 2, bandanna: 1, black_eye: 2, blind: 1, boom: 2, catch: 3,
    confetti_party: 1, efficient: 1, envy: 1, eye_patch: 2, famine: 3, floor_is_lava: 1, fog: 3,
    foreign: 2, ghost: 2, give_and_take: 1, grunt_birthday_party: 1, grunt_funeral: 2, johnny_ammo: 2,
    leadhead: 2, m_rating: 1, malfunction: 2, mythic: 3, need_glasses: 1, outbreak: 2, pinata: 1,
    protected: 2, recession: 2, rip_and_tear: 1, scarab: 1, sputnik: 2, streaking: 1, swarm: 2,
    thats_just_wrong: 2, thunderstorm: 3, tough_luck: 3, woe_is_me: 1,
};

/** skulls that each change the player's shields: at most one of them at once */
const SHIELD_SKULLS = ['black_eye', 'give_and_take', 'streaking', 'rip_and_tear'];

/** how many skulls a day turns on, by weight */
const SKULL_COUNT_WEIGHTS = { 0: 1, 1: 3, 2: 4, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1, 8: 1 };

/** the actors a squad may become (game.randomizer_pool), with their labels */
const POOLS = [
    { pool: 'any', weight: 6, label: 'ALL KINDS' },
    { pool: 'covenant', weight: 4, label: 'COVENANT ONLY' },
    { pool: 'flood', weight: 4, label: 'FLOOD ONLY' },
    { pool: 'human', weight: 1, label: 'MARINES ONLY' },
    { pool: 'one', weight: 4, label: null },
];

/**
 * game.randomizer_pool "one"'s types, with the ranks each may have (its
 * game.randomizer_<type>_rank); engineers, carriers and infection forms
 * alone do not fight, and are left out
 */
const ONE_TYPES = [
    { type: 'grunt', weight: 3, label: 'GRUNTS', ranks: ['any', 'minor', 'major', 'specops'] },
    { type: 'elite', weight: 3, label: 'ELITES', ranks: ['any', 'minor', 'major', 'specops', 'zealot', 'stealth'] },
    { type: 'jackal', weight: 2, label: 'JACKALS', ranks: ['any', 'minor', 'major'] },
    { type: 'hunter', weight: 1, label: 'HUNTERS', ranks: ['any'] },
    { type: 'flood_combat', weight: 2, label: 'COMBAT FORMS', ranks: ['any', 'human', 'elite'] },
    { type: 'sentinel', weight: 1, label: 'SENTINELS', ranks: null },
    { type: 'marine', weight: 1, label: 'MARINES', ranks: null },
];
const RANK_SETTINGS = {
    grunt: 'game.randomizer_grunt_rank',
    elite: 'game.randomizer_elite_rank',
    jackal: 'game.randomizer_jackal_rank',
    hunter: 'game.randomizer_hunter_rank',
    flood_combat: 'game.randomizer_flood_combat_rank',
};

/** game.randomizer_pickup_pool's and _weapon_pool's choices (power: the actors' only) */
const WEAPON_POOLS = [
    { pool: 'any', weight: 5, label: 'ANY' },
    { pool: 'covenant', weight: 2, label: 'COVENANT' },
    { pool: 'human', weight: 2, label: 'HUMAN' },
    { pool: 'precision', weight: 1, label: 'PRECISION' },
    { pool: 'automatic', weight: 1, label: 'AUTOMATIC' },
    { pool: 'power', weight: 1, label: 'POWER', actorsOnly: true },
    { pool: 'one', weight: 1, label: null },
];
/** the weapons "one" may be (randomizer.c's weapon_kinds) */
const WEAPON_KINDS = [
    { kind: 'pistol', label: 'PISTOL' },
    { kind: 'assault_rifle', label: 'ASSAULT RIFLE' },
    { kind: 'shotgun', label: 'SHOTGUN' },
    { kind: 'sniper_rifle', label: 'SNIPER RIFLE' },
    { kind: 'rocket_launcher', label: 'ROCKET LAUNCHER' },
    { kind: 'plasma_pistol', label: 'PLASMA PISTOL' },
    { kind: 'plasma_rifle', label: 'PLASMA RIFLE' },
    { kind: 'needler', label: 'NEEDLER' },
    { kind: 'fuel_rod', label: 'FUEL ROD', actorsOnly: true },
    { kind: 'energy_sword', label: 'ENERGY SWORD', actorsOnly: true },
];

/** how a difficulty is picked: mostly Heroic */
const DIFFICULTY_WEIGHTS = { 1: 3, 2: 5, 3: 2 };

const CHALLENGE_VERSION = 1;

// ---------- the server's day

function serverTimeZone() {
    const configured = (process.env.HALO_DAILY_TIMEZONE || '').trim();
    if (configured) {
        try {
            new Intl.DateTimeFormat('en-US', { timeZone: configured });
            return configured;
        } catch (_error) {
            console.error(`HALO_DAILY_TIMEZONE "${configured}" is not a time zone; using the server's`);
        }
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function zonedParts(date, timeZone) {
    const parts = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date)) {
        parts[part.type] = part.value;
    }
    return parts;
}

/** YYYY-MM-DD of the instant, in the time zone */
function dayKeyAt(date, timeZone = serverTimeZone()) {
    const parts = zonedParts(date, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function isDayKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** the time zone's offset from UTC at the instant, in milliseconds */
function zoneOffset(date, timeZone) {
    const parts = zonedParts(date, timeZone);
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second));
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** the instant the day begins, in the time zone (twice round for a change of offset) */
function dayStart(dayKey, timeZone = serverTimeZone()) {
    const [year, month, day] = dayKey.split('-').map(Number);
    const midnight = Date.UTC(year, month - 1, day);
    let guess = midnight;
    for (let pass = 0; pass < 2; pass++) {
        guess = midnight - zoneOffset(new Date(guess), timeZone);
    }
    return new Date(guess);
}

function addDays(dayKey, days) {
    const [year, month, day] = dayKey.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** the instant the day's leaderboard stops taking scores: the next day's start */
function dayEnd(dayKey, timeZone = serverTimeZone()) {
    return dayStart(addDays(dayKey, 1), timeZone);
}

// ---------- picking

function pickWeighted(entries, weightOf, random) {
    const total = entries.reduce((sum, entry) => sum + weightOf(entry), 0);
    let roll = random(total);
    for (const entry of entries) {
        roll -= weightOf(entry);
        if (roll < 0) return entry;
    }
    return entries[entries.length - 1];
}

function pickWeightedKey(weights, random) {
    return pickWeighted(Object.keys(weights), (key) => weights[key], random);
}

function pickOne(entries, random) {
    return entries[random(entries.length)];
}

function chance(percent, random) {
    return random(100) < percent;
}

/** a weapon pool and, for "one", its weapon; labelled */
function pickWeapons(random, forActors) {
    const pools = WEAPON_POOLS.filter((entry) => forActors || !entry.actorsOnly);
    const pool = pickWeighted(pools, (entry) => entry.weight, random);
    if (pool.pool !== 'one') return { pool: pool.pool, kind: null, label: pool.label };
    const kinds = WEAPON_KINDS.filter((entry) => forActors || !entry.actorsOnly);
    const kind = pickOne(kinds, random);
    return { pool: 'one', kind: kind.kind, label: `${kind.label} ONLY` };
}

/** the skulls: weighted, without two that change the shields */
function pickSkulls(count, random) {
    const chosen = [];
    let remaining = { ...SKULL_WEIGHTS };
    while (chosen.length < count && Object.keys(remaining).length) {
        const skull = pickWeightedKey(remaining, random);
        chosen.push(skull);
        delete remaining[skull];
        if (SHIELD_SKULLS.includes(skull)) {
            remaining = Object.fromEntries(Object.entries(remaining).filter(([key]) => !SHIELD_SKULLS.includes(key)));
        }
    }
    return chosen.sort();
}

function cryptoRandom(limit) {
    return crypto.randomInt(limit);
}

/**
 * a day's challenge, at random: a level (not the day before's), a
 * difficulty, the randomizer's setup (always the enemies), skulls, and the
 * seed every player's randomizer uses in place of its own roll, so they all
 * face the same enemies
 */
function generateChallenge(dayKey, { previousLevel = null, random = cryptoRandom, timeZone = serverTimeZone() } = {}) {
    const levels = LEVELS.filter((level) => level.key !== previousLevel);
    const level = pickOne(levels, random);
    const difficulty = Number(pickWeightedKey(DIFFICULTY_WEIGHTS, random));

    const pool = pickWeighted(POOLS, (entry) => entry.weight, random);
    let type = ONE_TYPES[0];
    let rank = 'any';
    let enemiesLabel = pool.label;
    if (pool.pool === 'one') {
        type = pickWeighted(ONE_TYPES, (entry) => entry.weight, random);
        rank = type.ranks ? pickOne(type.ranks, random) : 'any';
        enemiesLabel = `${rank === 'any' ? '' : `${rank.toUpperCase()} `}${type.label} ONLY`;
    }
    const allies = chance(25, random);
    const pickups = chance(65, random) ? pickWeapons(random, false) : null;
    const weapons = chance(65, random) ? pickWeapons(random, true) : null;
    const crazy = chance(15, random);
    const crazyParts = {
        weapons: crazy && chance(70, random),
        enemies: crazy && chance(70, random),
        flamethrower: crazy && chance(50, random),
        pods: crazy ? 10 * (1 + random(10)) : 30,
    };
    const skulls = pickSkulls(Number(pickWeightedKey(SKULL_COUNT_WEIGHTS, random)), random);
    const seed = 1 + random(0xFFFFFFFE);

    const text = (value) => (value ? 'true' : 'false');
    const config = {
        'game.campaign_score': 'true',
        'game.randomizer': 'true',
        'game.randomizer_enemies': 'true',
        'game.randomizer_allies': text(allies),
        'game.randomizer_pool': pool.pool,
        'game.randomizer_type': type.type,
        'game.randomizer_pickups': text(!!pickups),
        'game.randomizer_pickup_pool': pickups ? pickups.pool : 'any',
        'game.randomizer_pickup_type': pickups && pickups.kind ? pickups.kind : 'pistol',
        'game.randomizer_enemy_weapons': text(!!weapons),
        'game.randomizer_weapon_pool': weapons ? weapons.pool : 'any',
        'game.randomizer_weapon_type': weapons && weapons.kind ? weapons.kind : 'plasma_rifle',
        'game.randomizer_crazy': text(crazy),
        'game.randomizer_crazy_weapons': text(crazyParts.weapons),
        'game.randomizer_crazy_enemies': text(crazyParts.enemies),
        'game.randomizer_crazy_flamethrower': text(crazyParts.flamethrower),
        'game.randomizer_crazy_pods': String(crazyParts.pods),
        'game.skulls': text(skulls.length > 0),
        'game.skulls_active': skulls.join(','),
        // (every skull had for the run, none dropped, none lost on a death)
        'game.skulls_unlock_mode': 'play',
        'game.skulls_all_unlocked': 'true',
        'game.skulls_instant_unlock': 'false',
        'game.skulls_lose_on_death': 'false',
        'game.skulls_drop_count': '0',
    };
    for (const [name, setting] of Object.entries(RANK_SETTINGS)) {
        config[setting] = pool.pool === 'one' && type.type === name ? rank : 'any';
    }

    const details = [
        `ENEMIES: ${enemiesLabel}${allies ? ', ALLIES TOO' : ''}`,
        `ENEMY WEAPONS: ${weapons ? weapons.label : 'NOT RANDOMIZED'}`,
        `PICKUPS: ${pickups ? pickups.label : 'NOT RANDOMIZED'}`,
    ];
    if (crazy) details.push('GO CRAZY: ON');

    return {
        day: dayKey,
        version: CHALLENGE_VERSION,
        level: level.key,
        levelTitle: level.title,
        difficulty,
        difficultyName: DIFFICULTIES[difficulty],
        seed,
        skulls,
        details,
        config,
        opensAt: dayStart(dayKey, timeZone),
        closesAt: dayEnd(dayKey, timeZone),
        timeZone,
    };
}

module.exports = {
    LEVELS,
    DIFFICULTIES,
    SKULL_WEIGHTS,
    CHALLENGE_VERSION,
    serverTimeZone,
    dayKeyAt,
    isDayKey,
    dayStart,
    dayEnd,
    addDays,
    generateChallenge,
    pickSkulls,
};
