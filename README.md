# api-opence

OpenCE's community server: [Open CE Ultimate Campaign](https://github.com/Watanoge/open-ce-ultimate-campaign)'s
online leaderboards and daily challenges. The game asks it at `community.server`
(default `https://oceapi.watanoge.com`); its own code is `port/linux/game/community.c`.

## A tour of the management page

`GET /admin` is where the server is looked after: what players are doing, the
daily challenges, and the leaderboards. It asks for `HALO_ADMIN_CODE` first
(see [Developer portal and management](#developer-portal-and-management)).

### Overview

<img width="1198" height="356" alt="Overview: totals, and the latest level and challenge runs" src="https://github.com/user-attachments/assets/9a36d3f8-ba80-4d44-bf3d-16a1f47fd631" />

The first page, to see at a glance whether the community is playing and the
server taking scores. Across the top, the totals: players, level runs, level
bests, challenges made, and challenge scores. Below them, the latest runs of
campaign levels (when, level, player, score, time) and of daily challenges
(when, day, player, best, tries); a level or day opens its leaderboard. Under
it all, the server's day and time zone, which decide when a challenge opens
and closes.

### Daily challenges

<img width="1201" height="505" alt="Daily challenges: a week of days with their level, difficulty, skulls, players and best" src="https://github.com/user-attachments/assets/fa00e413-1ad7-4474-af15-7cce795a94ea" />

The calendar of challenges, a week at a time (**← Earlier**, **Later →**,
**This week**). Each day shows its level, difficulty, skulls, how many played
it and the best score, or that it is not set yet (a day to come) or was never
asked for (a day gone by that nobody played). Days to come can be looked at
and set ahead of time. A day opens its page.

<img width="950" height="858" alt="A daily challenge: its facts, the editor for level, difficulty, seed, randomizer and skulls, and its leaderboard" src="https://github.com/user-attachments/assets/554e9ad0-c4ba-4c6e-9362-4b7217b6d34f" />

One day's challenge, to see it and change it. At the top, the day (today, a
day gone by or to come), when it opens and closes, its players and best, its
version, and when it was made and last changed; the arrows and the date field
go to another day. Below, the editor: the level, the difficulty, the seed
(**New** draws one), the randomizer, one folder per screen of the game's own
(AI, equipped weapons, world weapons, Crazy Mode) with only the choices the
game allows, and the skulls. **Save** keeps the changes, **Discard changes**
drops them, **Regenerate** makes the day again at random, and **Delete**
removes it; a day not made yet has **Make it now**. A day that already has
scores asks whether to keep them or delete them, as a changed challenge is
another challenge. Last, the day's leaderboard with every field a score
keeps (score, time, difficulty, skulls, medals, kills and deaths, tries, the
day's own best, platform); a score can be deleted, and a player's place in
the day's top three taken back (**Clear day best**).

### Campaign levels

<img width="1199" height="563" alt="Campaign leaderboards: each level with its players, runs, best and last run" src="https://github.com/user-attachments/assets/b097c6d4-24f3-4b05-86ef-4b08a14e8ce0" />

Every campaign level's leaderboard in one list: its players, its runs, the
best (score, player, time), and when it was last played. A level opens its
page.

<img width="1174" height="366" alt="A level: its leaderboard and its runs, newest first" src="https://github.com/user-attachments/assets/1afbf7b1-0fba-4440-b32e-5172fcc0f425" />

One level, to keep its leaderboard honest. First its leaderboard, each
player's best run; deleting one deletes that player's runs of the level too.
Then every run as it came, newest first, with its platform and build;
deleting a run works its player's best out again from the runs left, so a
bad run can go without losing the player's others.

### Players

<img width="1178" height="244" alt="Players: found by name or id, with their levels, days, first and last seen" src="https://github.com/user-attachments/assets/7ebdd45a-378e-4b7e-9e5d-43a396d14813" />

Everyone who has sent a score, found by name or id: how many levels and days
they played, and when they were first and last seen. **Delete all** removes a
player and every score of theirs, from every leaderboard.

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
  the same enemies. Its leaderboard takes scores whenever it is played, and
  keeps the top three of the day itself (until midnight in
  `HALO_DAILY_TIMEZONE`) on top (`dayTop`). A score whose settings are not
  the day's is refused.
- **Accounts** (`database/halo_social.js`): an account is an install, whatever
  its players' names: the same key without the profile's part after it
  (`<64 hex>-<profile>` is the install's `<64 hex>`). No one registers; the
  first request makes it, with a public code (`XXXX-XXXX`, Crockford's base
  32) others know it by. It keeps the totals of every match and level the game
  sends (multiplayer and campaign: matches, wins, kills, deaths, assists,
  medals, each medal's count) and each one as it came (`account_matches`, a
  match sent twice taken once by its `matchId`).
- **Chat**: the fork's chat lines, numbered in order and kept 14 days:
  global, a match's (its `room`, a key the game makes for the game it is in)
  and its teams', and private ones between two accounts (by code). An account
  says 5 lines at once, then one each 1.5 seconds. A room knows the accounts
  that polled it in the last 30 seconds (in memory).
- **Friends** (`friendships`): one asks, the other accepts (or asks back).
  An account is online while it was heard from in the last 2 minutes (the
  game's `POST /presence` every 45 seconds: what it is doing, and the invite
  of the game it hosts). Its settings (`settings`, sent with `POST /account`,
  each on until set): `friends` (its friend list: off, it shows offline and
  takes no requests), `requests` (others may ask), `activity` (friends see
  what it plays and its matches), `join` (friends get its invite),
  `privateChat` (private lines reach it).
- **Moderation**: an account mutes (their lines never reach it), blocks
  (neither hears the other, no private lines or requests either way, their
  friendship ended) and reports (`account_reports`, once each; it mutes too).
  A player reported by 3 accounts or more has its lines hidden from everyone
  who did not ask for them (`reported=1`, which marks them).

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
| POST | `/daily/:day/scores` | a run of the day's challenge, whenever it is played |
| PUT | `/daily/:day` | a challenge set by hand (`x-admin-code: HALO_ADMIN_CODE`), for a day with no scores yet |
| POST | `/account` | the game started: the account (made the first time), its totals and medals; `{name, platform, build}` |
| GET | `/account` | the same, without noting the name |
| POST | `/account/matches` | a match or level played: `{matchId, kind: multiplayer\|campaign, result, score, kills, deaths, assists, suicides, betrayals, seconds, players, place, map, gametype, teams, medals: {key: count}, name}` |
| GET | `/account/matches` | `?limit=` (up to 50) the latest |
| POST | `/chat/messages` | a line: `{channel: global\|match\|team\|private, text, room, team, to, name}` |
| GET | `/chat/messages` | `?after=&room=&team=&global=0&reported=1&name=` the lines heard since `after` (none: the last 30), the cursor, and the room's players |
| POST | `/presence` | what the game is doing: `{state: menus\|campaign\|multiplayer\|theater, map, gametype, game, players, maximum, host, invite, name}`; the friends online and the requests waiting |
| GET | `/friends` | the friends (online first) and what they do, the requests to and from the account |
| POST | `/friends` | `{code}` asked to be its friend (accepted at once when it asked first) |
| POST | `/friends/accept` | `{code}` its request accepted |
| POST | `/friends/remove` | `{code}` a friend removed, a request declined or taken back |
| GET | `/players/:code` | `?matches=` (up to 20) a player: totals, medals, presence, latest matches, and what it is to the one asking |
| GET | `/activity` | `?limit=` (up to 50) the friends' latest matches and levels |
| GET | `/moderation` | the accounts muted and blocked |
| POST | `/moderation` | `{code, action: mute\|unmute\|block\|unblock\|report, reason}` |

## Developer portal and management

`GET /` is the developer portal: the server's status, today's challenge and
leaderboard, the conventions, and every endpoint (the GET ones can be tried
from the page). `GET /admin` manages the server, signed in with
`HALO_ADMIN_CODE` (none set: off):

- **Daily challenges**: any day's, before, today's or to come. A day can be
  made now at random (a day to come is otherwise made the first time it is
  asked for), made again, changed by hand (level, difficulty, seed, skulls,
  and the randomizer: its AI, equipped weapons, world weapons and Crazy Mode,
  chosen as the game's randomizer screens offer them), or deleted. The
  lines the game shows and the settings it is sent follow the randomizer
  and skulls. A day with scores is changed only when asked again, with its
  scores kept or deleted: a change of its level, difficulty, seed, skulls,
  version or randomizer makes them another challenge's, and (but for the
  randomizer, which a score does not send) the games still playing the old
  one are refused (`settings_mismatch`).
- **Leaderboards**: each day's and each campaign level's, every field kept;
  a score can be deleted (a level's with its player's runs of it), a run of
  a level deleted (its player's best worked out again from the runs left),
  and a day's top three entry taken from a player.
- **Players**: found by name or id, and deleted with every score of theirs.

Its page calls `/admin/api/...` (`routes/routes_admin.js`) with the code as
`x-admin-code`; ten wrong codes from one address keep it out for 15 minutes
(behind a proxy, set `TRUST_PROXY` so the address is the client's).

Answers are `{ "data": ... }`, or `{ "error": { "type": ... } }` with a
status of 4xx or 5xx. `database` (503) means MongoDB cannot be reached
(`MONGODB_URI`); `GET /status` says `"database": "ok"` or `"unavailable"`.

## CORS

Only the web build is subject to it: the desktop, Android, Switch and PS5
builds make their own HTTPS requests. Every origin is allowed (the page's
own is reflected, `null` for a file's page too), as nothing rides on cookies;
every answer carries the headers, errors included, and a preflight (the
`x-halo-key` header asks for one) is remembered for a day. A "CORS error" in
the browser therefore means the answer did not come from this server (a
proxy's error page, or the server down), not that the origin was refused.
