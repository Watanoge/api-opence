/**
 * Halo CE Universal daily challenges: the server's day, and a day's challenge
 * generated at random. Pure functions (no database): database/halo_sql.js
 * stores what generateChallenge returns, so a day's challenge never changes
 * once someone has seen it.
 *
 * The challenge's `randomizer` is its setup, as the game's randomizer screens
 * offer it (RANDOMIZER_GROUPS); its `config`, worked out from that and its
 * skulls (challengeConfig), is the set of the game's own settings
 * (port/linux/src/port_config.c's "section.key" names, values as text) the
 * game applies for the run without writing them to config.toml. Every
 * randomizer and skulls setting is given, so nothing of the player's own
 * setup leaks into a challenge; and its `details`, the lines the game shows,
 * are the randomizer's too (challengeDetails).
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

/**
 * the randomizer's settings a challenge sets, as the game's randomizer screens
 * offer them (port/assets/menus/ce/main_menu.difficulty_select.randomizer.xml's
 * spinners, and Settings > Gameplay > Randomizer's for Go Crazy): each a field
 * of a challenge's `randomizer`, its setting, and its choices, with the
 * labels the screens show. `needs`: the other fields' values it applies with
 * (a choice's: those it can be chosen with)
 */
const TOGGLE = [{ value: false, label: 'OFF' }, { value: true, label: 'ON' }];

function choices(values, labels) {
    const names = labels.split('|');
    return values.split('|').map((value, index) => ({ value, label: names[index] }));
}

/** (the flamethrower, multiplayer's, only with Go Crazy's) */
const FLAMETHROWER_NEEDS = { crazy: true, crazyFlamethrower: true };
const WEAPON_TYPES = choices(
    'pistol|assault_rifle|shotgun|sniper_rifle|rocket_launcher|flamethrower|plasma_pistol|plasma_rifle|needler',
    'PISTOL|ASSAULT RIFLE|SHOTGUN|SNIPER RIFLE|ROCKETS|FLAMETHROWER|PLASMA PISTOL|PLASMA RIFLE|NEEDLER')
    .map((choice) => (choice.value === 'flamethrower' ? { ...choice, needs: FLAMETHROWER_NEEDS } : choice));
const WEAPON_POOL_CHOICES = choices('any|covenant|human|precision|automatic|power|one',
    'ANY|COVENANT|HUMAN|PRECISION|AUTOMATIC|POWER|ONE TYPE');

/** the ranks of game.randomizer_type's types that have them, each its own setting */
const RANKS = {
    grunt: { label: 'RANK', setting: 'game.randomizer_grunt_rank',
        choices: choices('any|minor|major|specops', 'ANY|MINOR|MAJOR|SPEC OPS') },
    elite: { label: 'RANK', setting: 'game.randomizer_elite_rank',
        choices: choices('any|minor|major|specops|zealot|stealth', 'ANY|MINOR|MAJOR|SPEC OPS|ZEALOT|STEALTH') },
    jackal: { label: 'RANK', setting: 'game.randomizer_jackal_rank', choices: choices('any|minor|major', 'ANY|MINOR|MAJOR') },
    hunter: { label: 'RANK', setting: 'game.randomizer_hunter_rank', choices: choices('any|minor|major', 'ANY|MINOR|MAJOR') },
    flood_combat: { label: 'FORM OF', setting: 'game.randomizer_flood_combat_rank',
        choices: choices('any|human|elite', 'ANY|HUMAN|ELITE') },
};

const RANDOMIZER_GROUPS = [
    { key: 'enemies', title: 'AI', fields: [
        { key: 'enemies', label: 'ENEMIES', setting: 'game.randomizer_enemies', choices: TOGGLE },
        { key: 'allies', label: 'ALLIES TOO', setting: 'game.randomizer_allies', choices: TOGGLE,
            needs: { enemies: true } },
        { key: 'pool', label: 'ENEMY POOL', setting: 'game.randomizer_pool',
            choices: choices('any|covenant|flood|human|one', 'ANY|COVENANT|FLOOD|HUMAN|ONE TYPE'),
            needs: { enemies: true } },
        { key: 'type', label: 'ENEMY TYPE', setting: 'game.randomizer_type',
            choices: choices('grunt|elite|jackal|hunter|flood_combat|flood_carrier|marine|engineer|sentinel',
                'GRUNT|ELITE|JACKAL|HUNTER|COMBAT FORM|CARRIER FORM|MARINE|ENGINEER|SENTINEL'),
            needs: { enemies: true, pool: 'one' } },
        // (its choices and setting the type's: RANKS)
        { key: 'rank', label: 'RANK', ranks: RANKS, needs: { enemies: true, pool: 'one' } },
    ] },
    { key: 'weapons', title: 'Equipped Weapons', fields: [
        { key: 'enemyWeapons', label: 'ENEMY WEAPONS', setting: 'game.randomizer_enemy_weapons', choices: TOGGLE },
        { key: 'weaponPool', label: 'WEAPON POOL', setting: 'game.randomizer_weapon_pool', choices: WEAPON_POOL_CHOICES,
            needs: { enemyWeapons: true } },
        { key: 'weaponType', label: 'WEAPON TYPE', setting: 'game.randomizer_weapon_type',
            choices: [...WEAPON_TYPES, ...choices('fuel_rod|energy_sword', 'FUEL ROD|ENERGY SWORD')],
            needs: { enemyWeapons: true, weaponPool: 'one' } },
    ] },
    { key: 'pickups', title: 'World Weapons', fields: [
        { key: 'pickups', label: 'WEAPON PICKUPS', setting: 'game.randomizer_pickups', choices: TOGGLE },
        { key: 'pickupPool', label: 'PICKUP POOL', setting: 'game.randomizer_pickup_pool', choices: WEAPON_POOL_CHOICES,
            needs: { pickups: true } },
        { key: 'pickupType', label: 'PICKUP TYPE', setting: 'game.randomizer_pickup_type', choices: WEAPON_TYPES,
            needs: { pickups: true, pickupPool: 'one' } },
    ] },
    { key: 'crazy', title: 'Crazy Mode', fields: [
        { key: 'crazy', label: 'GO CRAZY', setting: 'game.randomizer_crazy', choices: TOGGLE },
        { key: 'crazyWeapons', label: 'ANY NPC, ANY WEAPON', setting: 'game.randomizer_crazy_weapons', choices: TOGGLE,
            needs: { crazy: true } },
        { key: 'crazyEnemies', label: 'ENGINEERS & SENTINELS', setting: 'game.randomizer_crazy_enemies', choices: TOGGLE,
            needs: { crazy: true } },
        { key: 'crazyFlamethrower', label: 'FLAMETHROWER', setting: 'game.randomizer_crazy_flamethrower', choices: TOGGLE,
            needs: { crazy: true } },
        { key: 'crazyPods', label: 'FLOOD PODS SWAPPED', setting: 'game.randomizer_crazy_pods',
            choices: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((value) => ({ value, label: `${value}%` })),
            needs: { crazy: true } },
    ] },
];
const RANDOMIZER_FIELDS = RANDOMIZER_GROUPS.flatMap((group) => group.fields);

/** a randomizer that changes nothing but the enemies (the game's own defaults otherwise) */
const RANDOMIZER_DEFAULTS = {
    enemies: true, allies: false, pool: 'any', type: 'grunt', rank: 'any',
    enemyWeapons: false, weaponPool: 'any', weaponType: 'plasma_rifle',
    pickups: false, pickupPool: 'any', pickupType: 'pistol',
    crazy: false, crazyWeapons: false, crazyEnemies: false, crazyFlamethrower: false, crazyPods: 30,
};

/** whether the randomizer has the values `needs` asks for */
function meets(randomizer, needs) {
    return !needs || Object.entries(needs).every(([key, value]) => randomizer[key] === value);
}

/** a field's choices, for the randomizer (the rank's: its type's) */
function fieldChoices(field, randomizer) {
    return field.ranks ? field.ranks[randomizer.type]?.choices ?? null : field.choices;
}

/**
 * the randomizer given (its fields, any of them) over `base`, checked against
 * the screens' choices: a field that applies must be one of its choices, and
 * one it can be chosen with; one that does not is its default if it is not
 */
function checkedRandomizer(base, given) {
    const errors = [];
    const randomizer = { ...RANDOMIZER_DEFAULTS, ...base };
    if (given === undefined) return { errors, randomizer };
    if (!given || typeof given !== 'object' || Array.isArray(given)) {
        return { errors: ['randomizer is an object of its fields'], randomizer };
    }
    for (const [key, value] of Object.entries(given)) {
        if (!(key in RANDOMIZER_DEFAULTS)) errors.push(`randomizer: ${key} is not one of its fields`);
        else randomizer[key] = value;
    }
    for (const field of RANDOMIZER_FIELDS) {
        const options = fieldChoices(field, randomizer);
        if (!options) {
            // (a type without ranks)
            randomizer[field.key] = 'any';
            continue;
        }
        const choice = options.find((option) => option.value === randomizer[field.key]);
        if (!choice) {
            // (one that does not apply is left as it is by default)
            if (meets(randomizer, field.needs)) {
                errors.push(`randomizer: ${field.key} is one of ${options.map((option) => JSON.stringify(option.value)).join(', ')}`);
            } else randomizer[field.key] = RANDOMIZER_DEFAULTS[field.key];
        } else if (meets(randomizer, field.needs) && !meets(randomizer, choice.needs)) {
            const names = Object.keys(choice.needs).map((key) => RANDOMIZER_FIELDS.find((other) => other.key === key).label);
            errors.push(`randomizer: ${field.label} ${choice.label} needs ${names.join(' and ')} on`);
        }
    }
    return { errors, randomizer };
}

/** the randomizer of a challenge's settings (one kept before challenges had their `randomizer`) */
function randomizerFromConfig(config = {}) {
    const randomizer = { ...RANDOMIZER_DEFAULTS };
    for (const field of RANDOMIZER_FIELDS) {
        const setting = field.ranks ? field.ranks[config['game.randomizer_type']]?.setting : field.setting;
        const text = setting ? config[setting] : undefined;
        if (text === undefined) continue;
        const choice = (fieldChoices(field, { type: config['game.randomizer_type'] }) || [])
            .find((option) => String(option.value) === text);
        if (choice) randomizer[field.key] = choice.value;
    }
    return randomizer;
}

/** the game's settings for a challenge: its randomizer's and its skulls' */
function challengeConfig(randomizer, skulls) {
    const config = { 'game.campaign_score': 'true', 'game.randomizer': 'true' };
    for (const field of RANDOMIZER_FIELDS) {
        if (field.ranks) {
            for (const [type, rank] of Object.entries(field.ranks)) {
                config[rank.setting] = randomizer.pool === 'one' && randomizer.type === type ? randomizer.rank : 'any';
            }
        } else config[field.setting] = String(randomizer[field.key]);
    }
    return {
        ...config,
        'game.skulls': skulls.length ? 'true' : 'false',
        'game.skulls_active': skulls.join(','),
        // (every skull had for the run, none dropped, none lost on a death)
        'game.skulls_unlock_mode': 'play',
        'game.skulls_all_unlocked': 'true',
        'game.skulls_instant_unlock': 'false',
        'game.skulls_lose_on_death': 'false',
        'game.skulls_drop_count': '0',
    };
}

/** how the challenge's lines name the randomizer's choices (community.c's random runs say the same) */
const POOL_LABELS = { any: 'ALL KINDS', covenant: 'COVENANT ONLY', flood: 'FLOOD ONLY', human: 'MARINES ONLY' };
const TYPE_LABELS = {
    grunt: 'GRUNTS', elite: 'ELITES', jackal: 'JACKALS', hunter: 'HUNTERS', flood_combat: 'COMBAT FORMS',
    flood_carrier: 'CARRIER FORMS', marine: 'MARINES', engineer: 'ENGINEERS', sentinel: 'SENTINELS',
};
const WEAPON_POOL_LABELS = {
    any: 'ANY', covenant: 'COVENANT', human: 'HUMAN', precision: 'PRECISION', automatic: 'AUTOMATIC', power: 'POWER',
};
const WEAPON_LABELS = {
    pistol: 'PISTOL', assault_rifle: 'ASSAULT RIFLE', shotgun: 'SHOTGUN', sniper_rifle: 'SNIPER RIFLE',
    rocket_launcher: 'ROCKET LAUNCHER', flamethrower: 'FLAMETHROWER', plasma_pistol: 'PLASMA PISTOL',
    plasma_rifle: 'PLASMA RIFLE', needler: 'NEEDLER', fuel_rod: 'FUEL ROD', energy_sword: 'ENERGY SWORD',
};

/** the lines the game shows of a challenge's randomizer */
function challengeDetails(randomizer) {
    const weapons = (on, pool, type) => {
        if (!on) return 'NOT RANDOMIZED';
        return pool === 'one' ? `${WEAPON_LABELS[type]} ONLY` : WEAPON_POOL_LABELS[pool];
    };
    let enemies = 'NOT RANDOMIZED';
    if (randomizer.enemies) {
        enemies = randomizer.pool === 'one' ?
            `${randomizer.rank === 'any' ? '' : `${randomizer.rank.toUpperCase()} `}${TYPE_LABELS[randomizer.type]} ONLY` :
            POOL_LABELS[randomizer.pool];
        if (randomizer.allies) enemies += ', ALLIES TOO';
    }
    const details = [
        `ENEMIES: ${enemies}`,
        `ENEMY WEAPONS: ${weapons(randomizer.enemyWeapons, randomizer.weaponPool, randomizer.weaponType)}`,
        `PICKUPS: ${weapons(randomizer.pickups, randomizer.pickupPool, randomizer.pickupType)}`,
    ];
    if (randomizer.crazy) details.push('GO CRAZY: ON');
    return details;
}

/** how a squad's actors are picked at random (game.randomizer_pool) */
const POOLS = [
    { pool: 'any', weight: 6 },
    { pool: 'covenant', weight: 4 },
    { pool: 'flood', weight: 4 },
    { pool: 'human', weight: 1 },
    { pool: 'one', weight: 4 },
];

/**
 * game.randomizer_pool "one"'s types picked at random, with the ranks each
 * may have; engineers, carriers and infection forms alone do not fight, and
 * are left out
 */
const ONE_TYPES = [
    { type: 'grunt', weight: 3, ranks: ['any', 'minor', 'major', 'specops'] },
    { type: 'elite', weight: 3, ranks: ['any', 'minor', 'major', 'specops', 'zealot', 'stealth'] },
    { type: 'jackal', weight: 2, ranks: ['any', 'minor', 'major'] },
    { type: 'hunter', weight: 1, ranks: ['any'] },
    { type: 'flood_combat', weight: 2, ranks: ['any', 'human', 'elite'] },
    { type: 'sentinel', weight: 1, ranks: null },
    { type: 'marine', weight: 1, ranks: null },
];

/** the weapon pools picked at random (power: the actors' only) */
const WEAPON_POOLS = [
    { pool: 'any', weight: 5 },
    { pool: 'covenant', weight: 2 },
    { pool: 'human', weight: 2 },
    { pool: 'precision', weight: 1 },
    { pool: 'automatic', weight: 1 },
    { pool: 'power', weight: 1, actorsOnly: true },
    { pool: 'one', weight: 1 },
];
/** the weapons "one" may be picked as (randomizer.c's weapon_kinds; no flamethrower) */
const WEAPON_KINDS = [
    { kind: 'pistol' },
    { kind: 'assault_rifle' },
    { kind: 'shotgun' },
    { kind: 'sniper_rifle' },
    { kind: 'rocket_launcher' },
    { kind: 'plasma_pistol' },
    { kind: 'plasma_rifle' },
    { kind: 'needler' },
    { kind: 'fuel_rod', actorsOnly: true },
    { kind: 'energy_sword', actorsOnly: true },
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

/** a weapon pool and, for "one", its weapon */
function pickWeapons(random, forActors) {
    const pools = WEAPON_POOLS.filter((entry) => forActors || !entry.actorsOnly);
    const pool = pickWeighted(pools, (entry) => entry.weight, random);
    if (pool.pool !== 'one') return { pool: pool.pool, kind: null };
    const kinds = WEAPON_KINDS.filter((entry) => forActors || !entry.actorsOnly);
    return { pool: 'one', kind: pickOne(kinds, random).kind };
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
    if (pool.pool === 'one') {
        type = pickWeighted(ONE_TYPES, (entry) => entry.weight, random);
        rank = type.ranks ? pickOne(type.ranks, random) : 'any';
    }
    const allies = chance(25, random);
    const pickups = chance(65, random) ? pickWeapons(random, false) : null;
    const weapons = chance(65, random) ? pickWeapons(random, true) : null;
    const crazy = chance(15, random);
    const randomizer = {
        enemies: true,
        allies,
        pool: pool.pool,
        type: type.type,
        rank,
        enemyWeapons: !!weapons,
        weaponPool: weapons ? weapons.pool : 'any',
        weaponType: weapons && weapons.kind ? weapons.kind : 'plasma_rifle',
        pickups: !!pickups,
        pickupPool: pickups ? pickups.pool : 'any',
        pickupType: pickups && pickups.kind ? pickups.kind : 'pistol',
        crazy,
        crazyWeapons: crazy && chance(70, random),
        crazyEnemies: crazy && chance(70, random),
        crazyFlamethrower: crazy && chance(50, random),
        crazyPods: crazy ? 10 * (1 + random(10)) : 30,
    };
    const skulls = pickSkulls(Number(pickWeightedKey(SKULL_COUNT_WEIGHTS, random)), random);
    const seed = 1 + random(0xFFFFFFFE);

    return {
        day: dayKey,
        version: CHALLENGE_VERSION,
        level: level.key,
        levelTitle: level.title,
        difficulty,
        difficultyName: DIFFICULTIES[difficulty],
        seed,
        skulls,
        randomizer,
        details: challengeDetails(randomizer),
        config: challengeConfig(randomizer, skulls),
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
    RANDOMIZER_GROUPS,
    checkedRandomizer,
    randomizerFromConfig,
    challengeConfig,
    challengeDetails,
    serverTimeZone,
    dayKeyAt,
    isDayKey,
    dayStart,
    dayEnd,
    addDays,
    generateChallenge,
    pickSkulls,
};
