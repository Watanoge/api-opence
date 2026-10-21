/**
 * OpenCE's community server: Halo CE Universal's online leaderboards and
 * daily challenges (routes/routes_halo.js). The game's community.server is
 * this server's address (https://oceapi.watanoge.com). Its developer portal
 * is its own page (public/index.html), and the management of its challenges
 * and leaderboards /admin's (public/admin.html, routes/routes_admin.js).
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const haloRoutes = require('./routes/routes_halo');
const adminRoutes = require('./routes/routes_admin');

const app = express();
const port = Number(process.env.PORT || 8082);

// (behind a proxy, its client's address, for the admin code's attempts)
// (true, a hop count, or Express's list of addresses)
const trustProxy = (process.env.TRUST_PROXY || '').trim();
if (trustProxy) {
    app.set('trust proxy', trustProxy === 'true' ? true : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}

// CORS only matters to the web build (the desktop, Android, Switch and PS5
// builds ask over their own HTTPS, which browsers' rules do not touch): any
// origin is let in, the page's own reflected (a site, localhost, or a file's
// "null"), as nothing here rides on cookies or the origin; the game's key
// header is allowed, and a preflight is remembered for a day
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-halo-key', 'x-admin-code'],
    maxAge: 86400,
}));
app.use(express.json({ limit: '64kb' }));

// the developer portal (/) and the management page (/admin)
const publicDirectory = path.join(__dirname, 'public');
app.get('/', (_req, res) => res.sendFile(path.join(publicDirectory, 'index.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(publicDirectory, 'admin.html')));
app.use('/portal', express.static(publicDirectory, { index: false, maxAge: '1h' }));

app.use('/admin/api', adminRoutes);
app.use('/', haloRoutes);

// (anything else, and a body that is not JSON: an answer as the others are,
// with the CORS headers above, so a browser can read why)
app.use((_req, res) => res.status(404).json({ error: { type: 'not_found' } }));
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
    const status = error.status || error.statusCode || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ error: { type: status === 400 ? 'bad_request' : 'internal' } });
});

app.listen(port, () => {
    console.log(`OpenCE API listening on port ${port}`);
});
