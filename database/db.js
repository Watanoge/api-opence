/**
 * The MongoDB connection, made once and kept (MONGODB_URI, MONGODB_DBNAME).
 */
const { MongoClient } = require('mongodb');
require('dotenv').config();

let clientPromise = null;

function client() {
    if (!clientPromise) {
        const uri = process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGODB_URI is not set');
        // (a server down fails a request in seconds, not the driver's 30)
        clientPromise = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }).connect().catch((error) => {
            clientPromise = null;
            throw error;
        });
    }
    return clientPromise;
}

async function collection(name) {
    const connected = await client();
    return connected.db(process.env.MONGODB_DBNAME || 'opence').collection(name);
}

/** whether the database answers, for /status */
async function databaseReachable() {
    try {
        const connected = await client();
        await connected.db(process.env.MONGODB_DBNAME || 'opence').command({ ping: 1 });
        return true;
    } catch (error) {
        console.error('database unreachable:', error.message);
        return false;
    }
}

/** an error of the database's (unreachable, refused, not configured) */
function isDatabaseError(error) {
    return /^Mongo/.test(error?.name || '') || /MONGODB_URI/.test(error?.message || '');
}

module.exports = { collection, databaseReachable, isDatabaseError };
