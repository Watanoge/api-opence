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
