/**
 * Makes the challenges of the days before today that have none (for testing
 * the history and past days), oldest first, each never the level of the day
 * before or after it.
 *
 *   node scripts/backfill_days.js [days=3]
 *
 * Uses .env's database. A day that has a challenge is left as it is.
 */
require('dotenv').config();
const { collection } = require('../database/db');
const daily = require('../utils/halo_daily');

async function main() {
    const count = Math.max(1, Math.min(60, parseInt(process.argv[2] || '3', 10) || 3));
    const challenges = await collection('daily_challenges');
    const today = daily.dayKeyAt(new Date());

    for (let back = count; back >= 1; back--) {
        const day = daily.addDays(today, -back);
        if (await challenges.findOne({ day })) {
            console.log(`${day}: already there`);
            continue;
        }
        const previous = await challenges.findOne({ day: daily.addDays(day, -1) });
        const next = await challenges.findOne({ day: daily.addDays(day, 1) });
        let challenge;
        do {
            challenge = daily.generateChallenge(day, { previousLevel: previous?.level ?? null });
        } while (next && challenge.level === next.level);
        await challenges.insertOne({ ...challenge, createdAt: new Date() });
        console.log(`${day}: ${challenge.levelTitle}, ${challenge.difficultyName}, ${challenge.skulls.length} skulls`);
    }
}

main().then(() => process.exit(0), (error) => {
    console.error(error);
    process.exit(1);
});
