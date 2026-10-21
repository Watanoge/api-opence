# api-opence

OpenCE's community server: [Halo CE Universal](https://github.com/thelinkin3000/halo-ce-universal)'s
online leaderboards and daily challenges. The game asks it at `community.server`
(default `https://oceapi.watanoge.com`); its own code is `port/linux/game/community.c`.

## Run

```sh
cp .env.example .env   # then fill it in
npm install
npm start              # or: npm run dev
npm test
```

Node 18 or later and MongoDB.

## What it keeps

A player is an install of the game: a random key it makes on first use and
sends as `X-Halo-Key`. The server keeps only its SHA-256, and shows the
profile name the game sends with each score.

- **Campaign leaderboards**: each level's best run of each player (the most
  points, then the shortest time), and every run as it came.
- **Daily challenges**: one a day, made the first time the day is asked for
  (`utils/halo_daily.js`): a campaign level, a difficulty, the randomizer's
  setup, skulls, and a seed every player's randomizer uses, so everyone meets
  the same enemies. Its leaderboard takes scores until the day ends at
  midnight in `HALO_DAILY_TIMEZONE`; past days can still be read and played.
  A score whose settings are not the day's is refused.

## Endpoints

| Method | Path | |
| --- | --- | --- |
| GET | `/status` | the server's version, time and day |
| POST | `/levels/scores` | a campaign level won |
| GET | `/levels/:level/leaderboard` | `?limit=` (up to 50) |
| GET | `/daily` | today's challenge (and the key's best of it) |
| GET | `/daily/history` | `?before=YYYY-MM-DD&limit=` (up to 60) |
| GET | `/daily/:day` | a day's challenge, today's or before |
| GET | `/daily/:day/leaderboard` | `?limit=` |
| POST | `/daily/:day/scores` | a run of the day's challenge, until the day ends |
| PUT | `/daily/:day` | a challenge set by hand (`x-admin-code: HALO_ADMIN_CODE`), for a day with no scores yet |

Answers are `{ "data": ... }`, or `{ "error": { "type": ... } }` with a
status of 4xx or 5xx.
