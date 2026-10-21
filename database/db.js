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
        clientPromise = new MongoClient(uri).connect().catch((error) => {
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

module.exports = { collection };
