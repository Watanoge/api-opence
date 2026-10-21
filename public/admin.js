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
  // (the week, Monday to Sunday, of the day asked for)
  const from = weekStart(params.get('around') || meta.today);
  const to = shiftDay(from, 6);
  const result = await api('GET', `/days?from=${from}&to=${to}`);
  if (!result.ok) return failed(result);
  const { today } = result.data;
  const days = [...result.data.days].reverse();
  const thisWeek = weekStart(meta.today);
  const around = (day) => () => { location.hash = day === thisWeek ? '#/days' : `#/days?around=${day}`; };
  const shortDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined,
    { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const pager = h('div', { class: 'pager' },
    h('button', { onclick: around(shiftDay(from, -7)) }, '← Earlier'),
    h('span', { class: 'muted small' }, `${shortDay(from)} – ${shortDay(to)}`),
    from === thisWeek ? null : h('button', { class: 'small', onclick: around(thisWeek) }, 'This week'),
    h('div', { class: 'spacer' }),
    h('button', { onclick: around(shiftDay(from, 7)) }, 'Later →'));
  $('view').replaceChildren(
    h('div', { class: 'card flush' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Daily challenges')),
      table([
        { label: 'Day', value: (row) => h('span', {},
          h('span', { class: 'weekday' }, new Date(`${row.day}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short' })),
          h('span', { class: 'mono' }, row.day)) },
        { label: 'Level', value: (row) => row.set ? `${row.levelTitle} (${row.level})` : h('span', { class: 'muted' }, row.when === 'future' ? 'not set yet' : 'never asked for') },
        { label: 'Difficulty', value: (row) => row.set ? DIFFICULTY_NAMES[row.difficulty] : '' },
        { label: 'Skulls', wrap: true, value: (row) => row.set ? (row.skulls.map(skullName).join(', ') || 'none') : '' },
        { label: 'Players', num: true, value: (row) => row.players || '' },
        { label: 'Best', value: (row) => row.bestScore != null ? `${number(row.bestScore)} · ${row.bestName}` : '' },
      ], days, { onRow: (row) => { location.hash = `#/days/${row.day}`; }, rowClass: (row) => row.day === today ? 'today' : '' }),
      pager));
}

/** the Monday of the day's week */
function weekStart(day) {
  const [year, month, date] = day.split('-').map(Number);
  return shiftDay(day, -((new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7));
}

function shiftDay(day, days) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** an instant in the server's time zone, as its days are */
const zoned = (value, options) => new Date(value).toLocaleString(undefined, { timeZone: meta.timeZone, ...options });

/** how far the day is from today ("tomorrow", "3 days ago"), and for today, how long it has left */
function dayDistance(day, data) {
  if (data.when === 'today') {
    const minutes = Math.max(0, Math.round((new Date(data.closesAt) - Date.now()) / 60000));
    return `Closes in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }
  const days = Math.round((Date.parse(day) - Date.parse(meta.today)) / 86400e3);
  const text = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(days, 'day');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** the day's header: where it is among the days, what it is, and (actions) what can be done with it */
function dayHead(day, data, actions) {
  const challenge = data.challenge;
  const longDay = new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined,
    { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const shortDay = (other) => new Date(`${other}T12:00:00Z`).toLocaleDateString(undefined,
    { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const best = data.scores[0];
  const fact = (label, value, note) => h('div', { class: 'fact' },
    h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), note ? h('div', { class: 'note' }, note) : null);
  const clock = (value) => zoned(value, { hour: '2-digit', minute: '2-digit' });
  const go = (other) => () => { location.hash = `#/days/${other}`; };
  const jump = h('input', { type: 'date', value: day, 'aria-label': 'Go to day',
    onchange: () => { if (jump.value && jump.value !== day) location.hash = `#/days/${jump.value}`; } });

  return h('div', { class: 'day-head' },
    h('div', { class: 'day-nav' },
      h('a', { href: `#/days?around=${day}` }, '← All days'),
      data.when === 'today' ? null : h('button', { class: 'small', onclick: go(meta.today) }, 'Go to today'),
      h('div', { class: 'spacer' }),
      h('div', { class: 'day-step' },
        h('button', { onclick: go(shiftDay(day, -1)), title: 'Day before' }, `‹ ${shortDay(shiftDay(day, -1))}`),
        jump,
        h('button', { onclick: go(shiftDay(day, 1)), title: 'Day after' }, `${shortDay(shiftDay(day, 1))} ›`))),
    h('div', { class: 'day-main' },
      h('div', { class: 'day-title' },
        h('div', {}, h('span', { class: `badge ${data.when}` }, dayDistance(day, data))),
        h('h2', {}, longDay),
        h('div', { class: 'sub' }, challenge ?
          `${challenge.levelTitle} · ${DIFFICULTY_NAMES[challenge.difficulty]} · ${challenge.skulls.length} skull${challenge.skulls.length === 1 ? '' : 's'}` :
          'No challenge yet')),
      actions),
    h('div', { class: 'facts' },
      fact('Open', `${clock(data.opensAt)} – ${clock(data.closesAt)}`, meta.timeZone),
      fact('Players', `${number(data.players)}${best ? ` · best ${number(best.score)} by ${best.name}` : ''}`),
      challenge ? fact('Version', challenge.version) : null,
      challenge ? fact('Made', date(challenge.createdAt)) : null,
      challenge?.updatedAt ? fact('Changed', date(challenge.updatedAt)) : null));
}

async function dayView(day) {
  setTab('days');
  loading();
  const result = await api('GET', `/days/${day}`);
  if (!result.ok) return failed(result);
  const data = result.data;
  const challenge = data.challenge;

  // (the actions in the header, for the editor's changes: Save and Discard only with some)
  const editorCard = h('div', { class: 'card' });
  const actions = h('div', { class: 'day-actions' });
  let form = null;
  const showActions = () => {
    const dirty = Boolean(form?.dirty());
    actions.replaceChildren(...[].concat(challenge ? [
      dirty ? h('button', { onclick: discard }, 'Discard changes') : null,
      h('button', { class: 'danger', onclick: () => deleteDay(day, data) }, 'Delete'),
      h('button', { onclick: () => regenerate(day, true) }, 'Regenerate'),
      h('button', { class: 'primary', disabled: !dirty, onclick: () => save(day, form.fields()) }, 'Save'),
    ] : [h('button', { class: 'primary', onclick: () => regenerate(day, false) }, 'Make it now')]).filter(Boolean));
  };
  const discard = () => {
    form = editor(challenge, showActions);
    editorCard.replaceChildren(form.node);
    showActions();
  };
  if (challenge) discard();
  else {
    editorCard.replaceChildren(unsetDay(data));
    showActions();
  }

  const sections = [h('div', { class: 'card' }, dayHead(day, data, actions)), editorCard];
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

function unsetDay(data) {
  return h('p', { class: 'muted', style: 'margin:0' }, data.when === 'future' ?
    'No challenge set for this day yet: one is made at random the first time the day is asked for. Make it now to see it, or change it.' :
    'No challenge was made for this day (nobody asked for it).');
}

/** the challenge's fields to change: its node, the fields as they are, and whether they differ from the challenge's (onChange: each change) */
function editor(challenge, onChange) {
  const levels = h('select', {}, meta.levels.map((level) =>
    h('option', { value: level.key, selected: level.key === challenge.level }, `${level.title} (${level.key})`)));
  const difficulty = h('select', {}, meta.difficulties.map((name, index) =>
    h('option', { value: index, selected: index === challenge.difficulty }, DIFFICULTY_NAMES[index])));
  const seed = h('input', { type: 'number', min: 1, max: 4294967295, value: challenge.seed });
  const skullBoxes = meta.skulls.map((skull) => h('input', { type: 'checkbox', value: skull, checked: challenge.skulls.includes(skull) }));
  const randomizer = randomizerEditor(challenge.randomizer);

  const fields = () => ({
    level: levels.value,
    difficulty: Number(difficulty.value),
    seed: Number(seed.value),
    skulls: skullBoxes.filter((box) => box.checked).map((box) => box.value),
    randomizer: randomizer.value(),
  });

  const node = h('div', { class: 'stack' },
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, 'Level', levels),
      h('label', { class: 'field' }, 'Difficulty', difficulty),
      h('label', { class: 'field' }, 'Seed', h('div', { class: 'row' }, seed,
        h('button', { type: 'button', class: 'small', onclick: () => { seed.value = 1 + Math.floor(Math.random() * 0xFFFFFFFE); onChange(); } }, 'New')))),
    h('div', {}, h('h3', {}, 'Randomizer'), randomizer.node),
    h('div', {}, h('h3', {}, `Skulls`),
      h('div', { class: 'skull-grid' }, skullBoxes.map((box) => h('label', {}, box, skullName(box.value))))));
  const initial = JSON.stringify(fields());
  node.addEventListener('input', () => onChange());
  node.addEventListener('change', () => onChange());
  return { node, fields, dirty: () => JSON.stringify(fields()) !== initial };
}

/** the randomizer's category open (kept from one day to another) */
let randomizerFolder = null;

const FOLDER_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2h7A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>';

/**
 * the randomizer's setup, as the game's randomizer screens offer it
 * (meta.randomizer): its categories as folders, one open at a time, each a
 * choice a field; a field that does not apply hidden, a choice that cannot be
 * had with the rest marked
 */
function randomizerEditor(initial) {
  const value = { ...initial };
  const allFields = meta.randomizer.flatMap((group) => group.fields);
  const labelOf = (key) => allFields.find((field) => field.key === key).label;
  const meets = (needs) => !needs || Object.entries(needs).every(([key, wanted]) => value[key] === wanted);
  const choicesOf = (field) => field.ranks ? field.ranks[value.type]?.choices ?? null : field.choices;
  const applies = (field) => Boolean(choicesOf(field)) && meets(field.needs);
  const choiceOf = (field) => choicesOf(field).find((option) => option.value === value[field.key]);
  if (!meta.randomizer.some((group) => group.key === randomizerFolder)) randomizerFolder = meta.randomizer[0].key;

  /** a category at a glance: off (its first field, the switch), or its choices */
  const summary = (group) => {
    const [main, ...rest] = group.fields;
    if (!value[main.key]) return 'Off';
    const parts = rest.filter(applies).map((field) => {
      const choice = choiceOf(field);
      if (typeof choice?.value === 'boolean') return choice.value ? field.label : null;
      return field.ranks ? `${choice?.label} rank` : choice?.label;
    }).filter(Boolean);
    return ['On', ...parts].join(' · ');
  };

  const rows = [];
  const folders = meta.randomizer.map((group) => {
    const note = h('span', { class: 'summary' });
    const button = h('button', { type: 'button', role: 'tab',
      onclick: () => { randomizerFolder = group.key; refresh(); } },
      h('span', { class: 'name' }, h('span', { class: 'icon' }), group.title), note);
    button.querySelector('.icon').innerHTML = FOLDER_ICON;
    const pane = h('div', { class: 'folder-pane', role: 'tabpanel' },
      h('h4', {}, group.title),
      h('div', { class: 'form-grid' }, group.fields.map((field) => {
        const select = h('select', { onchange: () => { value[field.key] = choicesOf(field)[select.value].value; refresh(); } });
        const label = h('span');
        const node = h('label', { class: 'field' }, label, select);
        rows.push({ field, select, label, node });
        return node;
      })));
    return { group, button, note, pane };
  });

  function refresh() {
    for (const { field, select, label, node } of rows) {
      const options = choicesOf(field);
      node.hidden = !applies(field);
      if (!options) continue;
      label.textContent = field.ranks ? field.ranks[value.type].label : field.label;
      let selected = options.findIndex((option) => option.value === value[field.key]);
      if (selected < 0) {
        // (a rank another type has: its first)
        selected = 0;
        value[field.key] = options[0].value;
      }
      select.replaceChildren(...options.map((option, index) => {
        const blocked = !meets(option.needs);
        return h('option', { value: index, selected: index === selected, disabled: blocked && index !== selected },
          blocked ? `${option.label} (needs ${Object.keys(option.needs).map(labelOf).join(' and ')} on)` : option.label);
      }));
    }
    for (const { group, button, note, pane } of folders) {
      const open = group.key === randomizerFolder;
      button.classList.toggle('active', open);
      button.classList.toggle('off', !value[group.fields[0].key]);
      button.setAttribute('aria-selected', String(open));
      note.textContent = summary(group);
      note.title = note.textContent;
      pane.hidden = !open;
    }
  }
  refresh();
  return {
    node: h('div', { class: 'folders' },
      h('div', { class: 'folder-list', role: 'tablist' }, folders.map((folder) => folder.button)),
      folders.map((folder) => folder.pane)),
    value: () => ({ ...value }),
  };
}

/** a change that has scores: whether to go on, and with them or without */
async function withScores(result) {
  const error = result.error;
  const answer = await choose('This day has scores', [
    `${error.players} player${error.players === 1 ? ' has' : 's have'} runs of this challenge.`,
    error.changes?.length ? `Changing ${error.changes.join(', ')} makes their runs another challenge's.` : '',
    error.changes?.some((change) => change !== 'randomizer') ? 'Games playing the old one will be refused (settings_mismatch).' : '',
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
  if (confirmFirst && !await choose('Regenerate this challenge?', 'A new level, difficulty, randomizer setup, skulls and seed, at random.', [
    { value: 'yes', label: 'Regenerate', class: 'primary' }])) return;
  let result = await api('POST', `/days/${day}/regenerate`, {});
  if (result.status === 409 && result.error?.type === 'has_scores') {
    const options = await withScores(result);
    if (!options) return;
    result = await api('POST', `/days/${day}/regenerate`, options);
  }
  if (!result.ok) return toast(errorText(result));
  toast(confirmFirst ? 'Regenerated' : 'Made');
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
