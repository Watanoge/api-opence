/**
 * Synced installs (database/halo_sync.js): an install that took another
 * account's sync code is a device of that account, whose key the social side
 * (halo_social.js) and the leaderboards (halo_sql.js) both read as the
 * account's.
 *
 * - account_links: a device (the SHA-256 of its install's key) and the
 *   account (the SHA-256 of the key it was made with) it belongs to
 * - player_links: a leaderboard player's old hash (its install's key and its
 *   profile's part) and the account-wide one its records are under now
 */
const { collection } = require('./db');

const ACCOUNT_LINKS = 'account_links';
const PLAYER_LINKS = 'player_links';

let indexesEnsured = null;

function ensureLinkIndexes() {
    if (!indexesEnsured) {
        indexesEnsured = (async () => {
            const links = await collection(ACCOUNT_LINKS);
            await links.createIndex({ device: 1 }, { unique: true });
            await links.createIndex({ account: 1 });
            await (await collection(PLAYER_LINKS)).createIndex({ from: 1 }, { unique: true });
        })().catch((error) => {
            indexesEnsured = null;
            throw error;
        });
    }
    return indexesEnsured;
}

/** the hash of the account an install's hash belongs to: its own unless it is a synced device */
async function resolveAccountHash(deviceHash) {
    await ensureLinkIndexes();
    const link = await (await collection(ACCOUNT_LINKS)).findOne({ device: deviceHash }, { projection: { account: 1 } });
    return link ? link.account : deviceHash;
}

/** the hash of the account an install's hash is part of when it is synced (a device, or the account devices joined), else null */
async function syncedAccountHash(installHash) {
    await ensureLinkIndexes();
    const links = await collection(ACCOUNT_LINKS);
    const device = await links.findOne({ device: installHash }, { projection: { account: 1 } });
    if (device) return device.account;
    return await links.findOne({ account: installHash }, { projection: { _id: 1 } }) ? installHash : null;
}

module.exports = {
    ACCOUNT_LINKS,
    PLAYER_LINKS,
    ensureLinkIndexes,
    resolveAccountHash,
    syncedAccountHash,
};
