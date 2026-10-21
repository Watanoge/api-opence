const test = require('node:test');
const assert = require('node:assert');
const daily = require('../utils/halo_daily');

test('a day starts at the time zone midnight, also across a change of offset', () => {
    for (const [timeZone, day, hours] of [
        ['America/Mexico_City', '2026-10-21', 24],
        ['America/New_York', '2026-03-08', 23],
        ['America/New_York', '2026-11-01', 25],
        ['Asia/Kolkata', '2026-10-21', 24],
    ]) {
        const start = daily.dayStart(day, timeZone);
        const end = daily.dayEnd(day, timeZone);
        assert.strictEqual((end - start) / 3600e3, hours, `${timeZone} ${day}`);
        assert.strictEqual(daily.dayKeyAt(start, timeZone), day);
        assert.strictEqual(daily.dayKeyAt(new Date(end - 1), timeZone), day);
        assert.strictEqual(daily.dayKeyAt(end, timeZone), daily.addDays(day, 1));
    }
});

test('day keys are checked', () => {
    assert.ok(daily.isDayKey('2026-02-28'));
    assert.ok(!daily.isDayKey('2026-02-30'));
    assert.ok(!daily.isDayKey('history'));
});

test('a challenge never repeats the day before, IRON, or two shield skulls', () => {
    const shields = ['black_eye', 'give_and_take', 'streaking', 'rip_and_tear'];
    for (let index = 0; index < 5000; index++) {
        const challenge = daily.generateChallenge('2026-10-21', { previousLevel: 'a30', timeZone: 'UTC' });
        assert.notStrictEqual(challenge.level, 'a30');
        assert.ok(!challenge.skulls.includes('iron'));
        assert.ok(challenge.skulls.filter((skull) => shields.includes(skull)).length <= 1);
        assert.ok(challenge.seed >= 1 && challenge.seed <= 0xFFFFFFFF);
        assert.ok(challenge.difficulty >= 1 && challenge.difficulty <= 3);
        assert.strictEqual(challenge.config['game.skulls_active'], challenge.skulls.join(','));
        assert.strictEqual(challenge.config['game.randomizer'], 'true');
    }
});

test("a challenge's settings and lines are its randomizer's", () => {
    for (let index = 0; index < 2000; index++) {
        const challenge = daily.generateChallenge('2026-10-21', { timeZone: 'UTC' });
        const { errors, randomizer } = daily.checkedRandomizer(challenge.randomizer, challenge.randomizer);
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(randomizer, challenge.randomizer);
        assert.deepStrictEqual(daily.randomizerFromConfig(challenge.config), challenge.randomizer);
        assert.deepStrictEqual(challenge.details, daily.challengeDetails(challenge.randomizer));
    }
});

test("a randomizer is checked against the game's screens", () => {
    const base = daily.generateChallenge('2026-10-21', { timeZone: 'UTC' }).randomizer;
    const elites = daily.checkedRandomizer(base, { enemies: true, pool: 'one', type: 'elite', rank: 'zealot' });
    assert.deepStrictEqual(elites.errors, []);
    const config = daily.challengeConfig(elites.randomizer, []);
    assert.strictEqual(config['game.randomizer_elite_rank'], 'zealot');
    assert.strictEqual(config['game.randomizer_grunt_rank'], 'any');
    assert.match(daily.challengeDetails(elites.randomizer)[0], /^ENEMIES: ZEALOT ELITES ONLY/);

    // (a rank the type has not got; a type without ranks has "any")
    assert.ok(daily.checkedRandomizer(base, { pool: 'one', type: 'grunt', rank: 'zealot' }).errors.length);
    assert.strictEqual(daily.checkedRandomizer(base, { pool: 'one', type: 'sentinel', rank: 'zealot' }).randomizer.rank, 'any');
    // (the flamethrower only with Go Crazy's)
    const flame = { pickups: true, pickupPool: 'one', pickupType: 'flamethrower' };
    assert.ok(daily.checkedRandomizer(base, { ...flame, crazy: false }).errors.length);
    assert.deepStrictEqual(daily.checkedRandomizer(base, { ...flame, crazy: true, crazyFlamethrower: true }).errors, []);
    // (values not the screens', and fields it has not got)
    assert.ok(daily.checkedRandomizer(base, { enemies: 'true' }).errors.length);
    assert.ok(daily.checkedRandomizer(base, { crazy: true, crazyPods: 35 }).errors.length);
    assert.ok(daily.checkedRandomizer(base, { shields: true }).errors.length);
    // (a field that does not apply is left as it was by default)
    assert.strictEqual(daily.checkedRandomizer(base, { crazy: false, crazyPods: 35 }).randomizer.crazyPods, 30);
});
