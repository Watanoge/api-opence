/*
 * The developer portal's management page (admin.html): the daily challenges
 * of any day, and the leaderboards' scores, over /admin/api
 * (routes/routes_admin.js), with the admin code as x-admin-code.
 */
'use strict';

const $ = (id) => document.getElementById(id);
const CODE_KEY = 'opence-admin-code';

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** the code kept: this tab's, or (remembered) this browser's */
function codeKept() {
  try {
    return sessionStorage.getItem(CODE_KEY) || localStorage.getItem(CODE_KEY) || '';
  } catch {
    return '';
  }
}

/** the code kept (remember: in this browser, not this tab alone), or forgotten (null) */
function codeKeep(value, remember) {
  try {
    sessionStorage.removeItem(CODE_KEY);
    localStorage.removeItem(CODE_KEY);
    if (value !== null) (remember ? localStorage : sessionStorage).setItem(CODE_KEY, value);
  } catch {
    // (storage off: signed in for this page only)
  }
}

let code = codeKept();
let meta = null;

// ---------- formatting

const DIFFICULTY_NAMES = ['Easy', 'Normal', 'Heroic', 'Legendary'];
const time = (seconds) => seconds == null ? '–' :
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
const number = (value) => value == null ? '–' : Number(value).toLocaleString();
const date = (value) => value ? new Date(value).toLocaleString() : '–';
const skullName = (key) => key.replace(/_/g, ' ');
const whenBadge = (when) => h('span', { class: `badge ${when}` }, when);

function toast(text) {
  const node = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(node);
  setTimeout(() => node.remove(), 2600);
}

function table(columns, rows, { onRow, rowClass, empty = 'Nothing here yet.' } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((column) => h('th', { class: column.num ? 'num' : null }, column.label)))),
    h('tbody', {}, rows.map((row) => h('tr', {
      class: [onRow ? 'clickable' : '', rowClass ? rowClass(row) : ''].join(' ').trim() || null,
      onclick: onRow ? (event) => { if (!event.target.closest('button')) onRow(row); } : null,
    }, columns.map((column) => h('td', { class: column.num ? 'num' : column.wrap ? 'wrap' : null }, column.value(row))))))));
}

// ---------- the API

async function api(method, path, body) {
  let answer;
  try {
    answer = await fetch(`/admin/api${path}`, {
      method,
      headers: { 'x-admin-code': code, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return { ok: false, status: 0, error: { type: 'unreachable' } };
  }
  let json = {};
  try {
    json = await answer.json();
  } catch {
    // (not JSON: a proxy's page)
  }
  if (answer.status === 403 && json.error?.type === 'forbidden') {
    signOut('The admin code was not accepted.');
  }
  return { ok: answer.ok, status: answer.status, data: json.data, error: json.error };
}

function errorText(result) {
  const error = result.error || {};
  if (error.type === 'validation') return error.errors.join('; ');
  if (error.type === 'unreachable') return 'The server could not be reached.';
  if (error.type === 'database') return 'The database is not answering.';
  if (error.type === 'admin_off') return 'HALO_ADMIN_CODE is not set on the server.';
  if (error.type === 'too_many_attempts') return 'Too many wrong codes from this address; try again in 15 minutes.';
  return `${error.type || 'error'} (${result.status})`;
}

/** a dialog's choice: the value of the button pressed (null: cancelled) */
function choose(title, body, buttons) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-body').replaceChildren(...[].concat(body).map((line) => typeof line === 'string' ? h('p', { style: 'margin:0 0 8px' }, line) : line));
  $('confirm-buttons').replaceChildren(
    h('button', { value: '' }, 'Cancel'),
    ...buttons.map((button) => h('button', { value: button.value, class: button.class || null }, button.label)));
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue || null), { once: true });
    dialog.returnValue = '';
    dialog.showModal();
  });
}

// ---------- signing in

function signOut(why) {
  code = '';
  codeKeep(null);
  $('tabs').hidden = true;
  $('sign-out').hidden = true;
  renderSignIn(why);
}

function renderSignIn(why) {
  const form = h('form', { class: 'stack' },
    h('label', { class: 'field' }, 'Admin code (HALO_ADMIN_CODE)',
      h('input', { id: 'code', type: 'password', autocomplete: 'current-password', required: true })),
    h('label', { class: 'row small' }, h('input', { type: 'checkbox', id: 'remember' }), 'Remember on this device'),
    why ? h('div', { class: 'notice bad' }, why) : null,
    h('button', { class: 'primary', type: 'submit' }, 'Sign in'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    code = $('code').value;
    const result = await api('GET', '/overview');
    if (!result.ok) {
      const message = errorText(result);
      code = '';
      return renderSignIn(message);
    }
    codeKeep(code, $('remember').checked);
    meta = result.data;
    start();
  });
  $('view').replaceChildren(h('div', { class: 'card', style: 'max-width:420px;margin:40px auto' }, h('h2', {}, 'Sign in'), form));
  $('code').focus();
}

function start() {
  $('tabs').hidden = false;
  $('sign-out').hidden = false;
  if (!location.hash) location.hash = '#/days';
  route();
}

$('sign-out').addEventListener('click', () => signOut());

// ---------- the views

function setTab(name) {
  for (const link of document.querySelectorAll('#tabs a')) link.classList.toggle('active', link.dataset.tab === name);
}

function loading() {
  $('view').replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
}

function failed(result) {
  $('view').replaceChildren(h('div', { class: 'notice bad' }, errorText(result)));
}

async function route() {
  if (!code) return renderSignIn();
  // (#/view/arg?query)
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
  const [view, arg] = path.split('/');
  const params = new URLSearchParams(query || '');
  if (!meta) {
    const result = await api('GET', '/overview');
    if (!result.ok) return failed(result);
    meta = result.data;
  }
  window.scrollTo(0, 0);
  if (view === 'overview') return overviewView();
  if (view === 'days' && arg) return dayView(arg);
  if (view === 'days') return daysView(params);
  if (view === 'levels' && arg) return levelView(arg);
  if (view === 'levels') return levelsView();
  if (view === 'players') return playersView(params);
  location.hash = '#/days';
}

window.addEventListener('hashchange', route);

// ---- the overview

async function overviewView() {
  setTab('overview');
  loading();
  const result = await api('GET', '/overview');
  if (!result.ok) return failed(result);
  meta = result.data;
  const counts = meta.counts;
  const stat = (label, value) => h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, number(value)));
  $('view').replaceChildren(
    h('section', { class: 'grid stats' },
      stat('Players', counts.players), stat('Level runs', counts.levelRuns), stat('Level bests', counts.levelBests),
      stat('Challenges', counts.challenges), stat('Challenge scores', counts.dailyScores)),
    h('section', { class: 'grid two' },
      h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', {}, 'Latest level runs')),
        table([
          { label: 'When', value: (row) => date(row.submittedAt) },
          { label: 'Level', value: (row) => h('a', { href: `#/levels/${row.level}` }, row.level) },
          { label: 'Player', value: (row) => row.name },
          { label: 'Score', num: true, value: (row) => number(row.score) },
          { label: 'Time', num: true, value: (row) => time(row.seconds) },
        ], meta.recentRuns)),
      h('div', { class: 'card flush' }, h('div', { class: 'card-head' }, h('h2', {}, 'Latest challenge runs')),
        table([
          { label: 'When', value: (row) => date(row.lastRunAt) },
          { label: 'Day', value: (row) => h('a', { href: `#/days/${row.day}` }, row.day) },
          { label: 'Player', value: (row) => row.name },
          { label: 'Best', num: true, value: (row) => number(row.score) },
          { label: 'Tries', num: true, value: (row) => row.attempts },
        ], meta.recentDaily))),
    h('p', { class: 'muted small' }, `Server day ${meta.today} (${meta.timeZone}).`));
}

// ---- the daily challenges

async function daysView(params) {
  setTab('days');
  loading();
  // (four weeks: the two before the day asked for, and the two after)
  const center = params.get('around') || meta.today;
  const from = shiftDay(center, -14);
  const to = shiftDay(center, 14);
  const result = await api('GET', `/days?from=${from}&to=${to}`);
  if (!result.ok) return failed(result);
  const { days, today } = result.data;
  const jump = h('input', { type: 'date', value: center });
  $('view').replaceChildren(
    h('div', { class: 'card flush' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Daily challenges'),
        h('span', { class: 'muted small' }, `${from} to ${to}`),
        h('div', { class: 'spacer' }),
        h('button', { onclick: () => { location.hash = `#/days?around=${shiftDay(center, -28)}`; } }, '← Earlier'),
        h('button', { onclick: () => { location.hash = '#/days'; } }, 'Today'),
        h('button', { onclick: () => { location.hash = `#/days?around=${shiftDay(center, 28)}`; } }, 'Later →'),
        jump,
        h('button', { onclick: () => { if (jump.value) location.hash = `#/days/${jump.value}`; } }, 'Open day')),
      table([
        { label: 'Day', value: (row) => h('span', { class: 'mono' }, row.day) },
        { label: '', value: (row) => whenBadge(row.when) },
        { label: 'Level', value: (row) => row.set ? `${row.levelTitle} (${row.level})` : h('span', { class: 'muted' }, row.when === 'future' ? 'not set yet' : 'never asked for') },
        { label: 'Difficulty', value: (row) => row.set ? DIFFICULTY_NAMES[row.difficulty] : '' },
        { label: 'Skulls', wrap: true, value: (row) => row.set ? (row.skulls.map(skullName).join(', ') || 'none') : '' },
        { label: 'Players', num: true, value: (row) => row.players || '' },
        { label: 'Best', value: (row) => row.bestScore != null ? `${number(row.bestScore)} · ${row.bestName}` : '' },
        { label: '', value: (row) => row.byHand ? h('span', { class: 'badge', title: 'Changed or made here' }, 'changed') : '' },
      ], days, { onRow: (row) => { location.hash = `#/days/${row.day}`; }, rowClass: (row) => row.day === today ? 'today' : '' })));
}

function shiftDay(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

async function dayView(day) {
  setTab('days');
  loading();
  const result = await api('GET', `/days/${day}`);
  if (!result.ok) return failed(result);
  const data = result.data;
  const challenge = data.challenge;

  const head = h('div', { class: 'card-head' },
    h('a', { href: `#/days?around=${day}` }, '← Days'),
    h('h2', {}, day), whenBadge(data.when),
    h('span', { class: 'muted small' }, `${date(data.opensAt)} – ${date(data.closesAt)}`),
    h('div', { class: 'spacer' }),
    h('button', { onclick: () => { location.hash = `#/days/${shiftDay(day, -1)}`; } }, '← Day before'),
    h('button', { onclick: () => { location.hash = `#/days/${shiftDay(day, 1)}`; } }, 'Day after →'));

  const sections = [h('div', { class: 'card' }, head, challenge ? editor(day, data) : unsetDay(day, data))];
  sections.push(h('div', { class: 'card flush' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Leaderboard'), h('span', { class: 'muted small' }, `${data.players} player${data.players === 1 ? '' : 's'}`)),
    table([
      { label: '#', num: true, value: (row) => row.rank },
      { label: 'Player', value: (row) => row.name },
      { label: 'Id', value: (row) => h('span', { class: 'mono', title: row.player }, row.id) },
      { label: 'Score', num: true, value: (row) => number(row.score) },
      { label: 'Time', num: true, value: (row) => time(row.seconds) },
      { label: 'Diff.', value: (row) => DIFFICULTY_NAMES[row.difficulty] ?? '–' },
      { label: 'Skulls', num: true, value: (row) => `${row.skulls} · ${row.skullsPercent}%` },
      { label: 'Medals', num: true, value: (row) => number(row.medals) },
      { label: 'K/D', num: true, value: (row) => `${row.kills ?? 0}/${row.deaths ?? 0}` },
      { label: 'Tries', num: true, value: (row) => row.attempts },
      { label: 'Day best', value: (row) => row.dayBest ? `${number(row.dayBest.score)} · ${time(row.dayBest.seconds)}` : '–' },
      { label: 'Platform', value: (row) => row.platform || '–' },
      { label: 'Achieved', value: (row) => date(row.achievedAt) },
      { label: '', value: (row) => h('div', { class: 'row nowrap' },
        row.dayBest ? h('button', { class: 'small', onclick: () => clearDayBest(day, row) }, 'Clear day best') : null,
        h('button', { class: 'small danger', onclick: () => deleteDayScore(day, row) }, 'Delete')) },
    ], data.scores, { empty: 'No runs of this day yet.' })));
  $('view').replaceChildren(h('div', { class: 'stack' }, ...sections));
}

function unsetDay(day, data) {
  return h('div', { class: 'stack' },
    h('p', { class: 'muted', style: 'margin:0' }, data.when === 'future' ?
      'No challenge set for this day yet: one is made at random the first time the day is asked for. Make it now to see it, or change it.' :
      'No challenge was made for this day (nobody asked for it).'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => regenerate(day, false) }, 'Make it now')));
}

function editor(day, data) {
  const challenge = data.challenge;
  const levels = h('select', {}, meta.levels.map((level) =>
    h('option', { value: level.key, selected: level.key === challenge.level }, `${level.title} (${level.key})`)));
  const difficulty = h('select', {}, meta.difficulties.map((name, index) =>
    h('option', { value: index, selected: index === challenge.difficulty }, DIFFICULTY_NAMES[index])));
  const seed = h('input', { type: 'number', min: 1, max: 4294967295, value: challenge.seed });
  const skullBoxes = meta.skulls.map((skull) => h('input', { type: 'checkbox', value: skull, checked: challenge.skulls.includes(skull) }));
  const details = h('textarea', { rows: 4 }, (challenge.details || []).join('\n'));
  const config = h('textarea', { rows: 14 }, JSON.stringify(challenge.config || {}, null, 2));
  const message = h('div');

  const fields = () => {
    let parsed;
    try {
      parsed = JSON.parse(config.value || '{}');
    } catch (error) {
      message.replaceChildren(h('div', { class: 'notice bad' }, `The settings are not JSON: ${error.message}`));
      return null;
    }
    return {
      level: levels.value,
      difficulty: Number(difficulty.value),
      seed: Number(seed.value),
      skulls: skullBoxes.filter((box) => box.checked).map((box) => box.value),
      details: details.value.split('\n').map((line) => line.trim()).filter(Boolean),
      config: parsed,
    };
  };

  return h('div', { class: 'stack' },
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, 'Level', levels),
      h('label', { class: 'field' }, 'Difficulty', difficulty),
      h('label', { class: 'field' }, 'Seed', h('div', { class: 'row' }, seed,
        h('button', { type: 'button', class: 'small', onclick: () => { seed.value = 1 + Math.floor(Math.random() * 0xFFFFFFFE); } }, 'New'))),
      h('label', { class: 'field' }, 'Version', h('input', { value: challenge.version, disabled: true }))),
    h('div', {}, h('h3', {}, `Skulls`),
      h('div', { class: 'skull-grid' }, skullBoxes.map((box) => h('label', {}, box, skullName(box.value))))),
    h('label', { class: 'field' }, 'Details (a line each, at most 4, shown in the game)', details),
    h('details', {}, h('summary', {}, 'Settings sent to the game (randomizer and skulls)'),
      h('p', { class: 'muted small' }, 'The game takes only game.randomizer*, game.skulls* and game.campaign_score. game.skulls and game.skulls_active follow the skulls above.'),
      config),
    message,
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: async () => {
        const body = fields();
        if (body) await save(day, body);
      } }, 'Save'),
      h('button', { onclick: () => regenerate(day, true) }, 'Make again at random'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'danger', onclick: () => deleteDay(day, data) }, 'Delete challenge')),
    h('details', {}, h('summary', {}, 'As the game is sent it'), h('pre', {}, JSON.stringify(data.asServed, null, 2))),
    h('p', { class: 'muted small', style: 'margin:0' },
      `Made ${date(challenge.createdAt)}${challenge.updatedAt ? `, changed ${date(challenge.updatedAt)}` : ''}.`));
}

/** a change that has scores: whether to go on, and with them or without */
async function withScores(result) {
  const error = result.error;
  const answer = await choose('This day has scores', [
    `${error.players} player${error.players === 1 ? ' has' : 's have'} runs of this challenge.`,
    error.changes?.length ? `Changing ${error.changes.join(', ')} makes their runs another challenge's: games playing the old one will be refused (settings_mismatch).` : '',
  ].filter(Boolean), [
    { value: 'keep', label: 'Change, keep scores' },
    { value: 'clear', label: 'Change, delete scores', class: 'danger' },
  ]);
  if (!answer) return null;
  return { force: true, clearScores: answer === 'clear' };
}

async function save(day, body) {
  let result = await api('PUT', `/days/${day}`, body);
  if (result.status === 409 && result.error?.type === 'has_scores') {
    const options = await withScores(result);
    if (!options) return;
    result = await api('PUT', `/days/${day}`, { ...body, ...options });
  }
  if (!result.ok) return toast(errorText(result));
  toast(result.data.scoresRemoved ? `Saved; ${result.data.scoresRemoved} scores deleted` : 'Saved');
  dayView(day);
}

async function regenerate(day, confirmFirst) {
  if (confirmFirst && !await choose('Make again at random?', 'A new level, difficulty, randomizer setup, skulls and seed.', [
    { value: 'yes', label: 'Make again', class: 'primary' }])) return;
  let result = await api('POST', `/days/${day}/regenerate`, {});
  if (result.status === 409 && result.error?.type === 'has_scores') {
    const options = await withScores(result);
    if (!options) return;
    result = await api('POST', `/days/${day}/regenerate`, options);
  }
  if (!result.ok) return toast(errorText(result));
  toast('Made');
  dayView(day);
}

async function deleteDay(day, data) {
  const answer = await choose('Delete this challenge?', [
    data.players ? `Its ${data.players} player${data.players === 1 ? "'s" : "s'"} scores are deleted with it.` : 'It has no scores.',
    data.when === 'past' ? 'A past day is not made again.' : 'A new one is made at random the next time the day is asked for.',
  ], [{ value: 'yes', label: 'Delete', class: 'danger' }]);
  if (!answer) return;
  const result = await api('DELETE', `/days/${day}?force=true`);
  if (!result.ok) return toast(errorText(result));
  toast('Deleted');
  dayView(day);
}

async function deleteDayScore(day, row) {
  if (!await choose(`Delete ${row.name}'s score?`, `${number(row.score)} points in ${time(row.seconds)}, ${row.attempts} tries.`,
    [{ value: 'yes', label: 'Delete', class: 'danger' }])) return;
  const result = await api('DELETE', `/days/${day}/scores/${row.player}`);
  if (!result.ok) return toast(errorText(result));
  toast('Deleted');
  dayView(day);
}

async function clearDayBest(day, row) {
  const result = await api('DELETE', `/days/${day}/scores/${row.player}/day-best`);
  if (!result.ok) return toast(errorText(result));
  toast("Cleared from the day's top three");
  dayView(day);
}

// ---- the campaign's levels

async function levelsView() {
  setTab('levels');
  loading();
  const result = await api('GET', '/levels');
  if (!result.ok) return failed(result);
  $('view').replaceChildren(h('div', { class: 'card flush' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Campaign leaderboards')),
    table([
      { label: 'Level', value: (row) => `${row.title} (${row.key})` },
      { label: 'Players', num: true, value: (row) => row.players },
      { label: 'Runs', num: true, value: (row) => row.runs },
      { label: 'Best', value: (row) => row.bestScore != null ? `${number(row.bestScore)} · ${row.bestName} · ${time(row.bestSeconds)}` : '–' },
      { label: 'Last run', value: (row) => date(row.lastRunAt) },
    ], result.data.levels, { onRow: (row) => { location.hash = `#/levels/${row.key}`; } })));
}

async function levelView(level) {
  setTab('levels');
  loading();
  const result = await api('GET', `/levels/${level}`);
  if (!result.ok) return failed(result);
  const data = result.data;
  $('view').replaceChildren(h('div', { class: 'stack' },
    h('div', { class: 'card flush' },
      h('div', { class: 'card-head' }, h('a', { href: '#/levels' }, '← Levels'), h('h2', {}, `${data.levelTitle} (${level})`),
        h('span', { class: 'muted small' }, `${data.players} player${data.players === 1 ? '' : 's'}`)),
      table([
        { label: '#', num: true, value: (row) => row.rank },
        { label: 'Player', value: (row) => row.name },
        { label: 'Id', value: (row) => h('span', { class: 'mono', title: row.player }, row.id) },
        { label: 'Score', num: true, value: (row) => number(row.score) },
        { label: 'Time', num: true, value: (row) => time(row.seconds) },
        { label: 'Diff.', value: (row) => DIFFICULTY_NAMES[row.difficulty] ?? '–' },
        { label: 'Skulls', num: true, value: (row) => `${row.skulls} · ${row.skullsPercent}%` },
        { label: 'Medals', num: true, value: (row) => number(row.medals) },
        { label: 'Runs', num: true, value: (row) => row.runs },
        { label: 'Achieved', value: (row) => date(row.achievedAt) },
        { label: '', value: (row) => h('button', { class: 'small danger', onclick: () => deleteLevelScore(level, row) }, 'Delete') },
      ], data.bests, { empty: 'No scores for this level yet.' })),
    h('div', { class: 'card flush' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Runs, newest first'),
        h('span', { class: 'muted small' }, "Deleting a run works its player's best out again from the runs left")),
      table([
        { label: 'When', value: (row) => date(row.submittedAt) },
        { label: 'Player', value: (row) => row.name },
        { label: 'Id', value: (row) => h('span', { class: 'mono', title: row.player }, row.id) },
        { label: 'Score', num: true, value: (row) => number(row.score) },
        { label: 'Time', num: true, value: (row) => time(row.seconds) },
        { label: 'Diff.', value: (row) => DIFFICULTY_NAMES[row.difficulty] ?? '–' },
        { label: 'Skulls', num: true, value: (row) => `${row.skulls} · ${row.skullsPercent}%` },
        { label: 'K/D', num: true, value: (row) => `${row.kills ?? 0}/${row.deaths ?? 0}` },
        { label: 'Players', num: true, value: (row) => row.players ?? 1 },
        { label: 'Platform', value: (row) => `${row.platform || '–'}${row.build ? ` #${row.build}` : ''}` },
        { label: '', value: (row) => h('button', { class: 'small danger', onclick: () => deleteRun(level, row) }, 'Delete') },
      ], data.runs, { empty: 'No runs yet.' }))));
}

async function deleteLevelScore(level, row) {
  if (!await choose(`Delete ${row.name}'s score?`, `Their best (${number(row.score)} points) and all ${row.runs} of their runs of this level.`,
    [{ value: 'yes', label: 'Delete', class: 'danger' }])) return;
  const result = await api('DELETE', `/levels/${level}/scores/${row.player}`);
  if (!result.ok) return toast(errorText(result));
  toast(`Deleted, with ${result.data.runsRemoved} runs`);
  levelView(level);
}

async function deleteRun(level, row) {
  if (!await choose('Delete this run?', `${row.name}: ${number(row.score)} points in ${time(row.seconds)}, ${date(row.submittedAt)}.`,
    [{ value: 'yes', label: 'Delete', class: 'danger' }])) return;
  const result = await api('DELETE', `/runs/${row._id}`);
  if (!result.ok) return toast(errorText(result));
  toast(result.data.best ? `Deleted; their best is now ${number(result.data.best.score)}` : 'Deleted; they have no runs left');
  levelView(level);
}

// ---- the players

async function playersView(params) {
  setTab('players');
  loading();
  const query = params.get('q') || '';
  const result = await api('GET', `/players?limit=200${query ? `&q=${encodeURIComponent(query)}` : ''}`);
  if (!result.ok) return failed(result);
  const search = h('input', { type: 'search', placeholder: 'Name or id', value: query });
  const form = h('form', { class: 'row' }, search, h('button', { type: 'submit' }, 'Search'));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    location.hash = `#/players?q=${encodeURIComponent(search.value.trim())}`;
  });
  $('view').replaceChildren(h('div', { class: 'card flush' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Players'), h('div', { class: 'spacer' }), form),
    table([
      { label: 'Name', value: (row) => row.name },
      { label: 'Id', value: (row) => h('span', { class: 'mono', title: row.keyHash }, row.id) },
      { label: 'Levels', num: true, value: (row) => row.levels },
      { label: 'Days', num: true, value: (row) => row.days },
      { label: 'First seen', value: (row) => date(row.createdAt) },
      { label: 'Last seen', value: (row) => date(row.lastSeenAt) },
      { label: '', value: (row) => h('button', { class: 'small danger', onclick: () => deletePlayer(row, params) }, 'Delete all') },
    ], result.data.players, { empty: query ? 'No player matches.' : 'No players yet.' })));
}

async function deletePlayer(row, params) {
  if (!await choose(`Delete ${row.name}?`, [
    `Every score of theirs: ${row.levels} level best${row.levels === 1 ? '' : 's'} with their runs, and ${row.days} challenge score${row.days === 1 ? '' : 's'}.`,
    'If they play again, they come back as a new player.',
  ], [{ value: 'yes', label: 'Delete all', class: 'danger' }])) return;
  const result = await api('DELETE', `/players/${row.keyHash}`);
  if (!result.ok) return toast(errorText(result));
  toast('Deleted');
  playersView(params);
}

// ---------- start

if (code) start();
else renderSignIn();
