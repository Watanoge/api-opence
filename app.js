/**
 * OpenCE's community server: Halo CE Universal's online leaderboards and
 * daily challenges (routes/routes_halo.js). The game's community.server is
 * this server's address (https://oceapi.watanoge.com).
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const haloRoutes = require('./routes/routes_halo');

const app = express();
const port = Number(process.env.PORT || 8082);

// (any origin: nothing here rides on cookies, and the web build and custom
// servers can be anywhere)
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-halo-key', 'x-admin-code'],
}));
app.use(express.json({ limit: '64kb' }));
app.use('/', haloRoutes);

app.listen(port, () => {
    console.log(`OpenCE API listening on port ${port}`);
});
