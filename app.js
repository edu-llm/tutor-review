/* Tutor dialogue review — static, no backend.
 *
 * Two-stage review, and the order is the whole point: stage 1 asks the reviewer to
 * answer AS the student with the gold answer hidden, stage 2 reveals it and asks
 * them to judge the tutor. Seeing the answer first would contaminate the reply and
 * make it useless as a persona seed.
 *
 * Answers live in localStorage until the reviewer downloads them.
 */
'use strict';

/* ─────────────────────────────────────────────────────────────────────────
 * SUBMIT_URL — leave empty and the app is download-only (current behaviour).
 * Point it at an endpoint that accepts `POST` with a JSON body and the app
 * will additionally try to submit the same payload the download produces:
 *
 *     const SUBMIT_URL = 'https://example.com/api/reviews';
 *
 * The endpoint must send `Access-Control-Allow-Origin` for this site's origin.
 * A failed POST never loses data — the download button is always the fallback.
 * ───────────────────────────────────────────────────────────────────────── */
const SUBMIT_URL = '';

const APP_VERSION = '1.0.0';
const SCHEMA = 'grpo-tutor-review/v1';
const STORE_PREFIX = 'grpo-tutor-review:v1:';
const LAST_KEY = STORE_PREFIX + '_last';
const AUTO_ADVANCE_MS = 900;

const LEAK_OPTS = [
  { value: 'no',          key: '1', title: 'No',           sub: 'never points at one option' },
  { value: 'hints_at_it', key: '2', title: 'Hints at it',  sub: 'you could work it out from this' },
  { value: 'names_it',    key: '3', title: 'Names it',     sub: 'says the answer, or rules out the rest' },
];
const HELP_OPTS = [
  { value: 'helps',     key: '4', title: 'Helps',      sub: 'moves the student towards understanding' },
  { value: 'too_vague', key: '5', title: 'Too vague',  sub: 'could be said about any question' },
  { value: 'just_tells', key: '6', title: 'Just tells', sub: 'hands it over instead of teaching' },
];

const $ = (id) => document.getElementById(id);

/* ── tiny deterministic PRNG, so a name always maps to the same items ───── */
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const normalizeName = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/* ── storage (private-mode safe) ────────────────────────────────────────── */
const store = {
  ok: (() => {
    try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; }
    catch { return false; }
  })(),
  get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/* ── state ──────────────────────────────────────────────────────────────── */
let DATA = null;          // items.json
let byId = new Map();
let session = null;       // { reviewer, reviewerId, startedAt, queue[], reviews{}, skipped[] }
let cursor = 0;
let stage = 1;
let draft = null;         // { leak, helpful } for the item on screen
let stageEnteredAt = 0;
let stage1Ms = 0;
let advanceTimer = null;

/* ── boot ───────────────────────────────────────────────────────────────── */
init();

async function init() {
  wireStaticHandlers();
  try {
    const res = await fetch('data/items.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    DATA = await res.json();
  } catch (err) {
    $('loading').hidden = true;
    fatal('Could not load the review items (' + err.message + '). Reload the page; if it keeps failing, tell Sophia.');
    return;
  }
  DATA.items.forEach((it) => byId.set(it.id, it));
  $('loading').hidden = true;

  $('landing-count').textContent =
    'About 15 seconds per dialogue. Works fine on a phone. Nothing is sent anywhere ' +
    'until you download your answers and send them on.';

  if (!store.ok) {
    fatal('This browser is blocking local storage (private/incognito mode?). ' +
          'Your answers would be lost on reload — please use a normal window.');
  }

  const last = store.get(LAST_KEY);
  if (last) {
    const prev = store.get(STORE_PREFIX + last.reviewerId);
    if (prev) {
      $('name').value = prev.reviewer;
      const done = Object.keys(prev.reviews || {}).length;
      $('resume-line').textContent =
        `Welcome back, ${prev.reviewer} — ${done} reviewed so far. ` +
        'Same name picks up exactly where you left off.';
      $('resume-line').hidden = false;
    }
  }
  show('landing');
}

function fatal(msg) {
  const el = $('fatal');
  el.textContent = msg;
  el.hidden = false;
}

/* ── screens ────────────────────────────────────────────────────────────── */
function show(which) {
  for (const name of ['landing', 'review', 'done']) {
    $('screen-' + name).hidden = which !== name;
  }
  $('topbar').hidden = which === 'landing';
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ── the queue ──────────────────────────────────────────────────────────────
 * Nobody is assigned a quota. The queue is: the shared overlap set FIRST, in a
 * fixed order everybody sees, then the entire remaining pool shuffled by a PRNG
 * seeded on the reviewer's name.
 *
 * Shared-set-first is what makes agreement data survive minimal effort: a
 * reviewer who does five items and stops has still labelled the five items
 * everybody else labelled. The name-seeded tail means different people start at
 * different points in the pool, so coverage spreads without telling anyone how
 * much to do.
 * ─────────────────────────────────────────────────────────────────────────── */
function buildQueue(reviewerId) {
  const shared = new Set(DATA.overlap_ids);
  const rest = DATA.items.map((i) => i.id).filter((id) => !shared.has(id));
  return DATA.overlap_ids.concat(shuffled(rest, mulberry32(hash32(reviewerId))));
}

function startSession(rawName) {
  const reviewerId = normalizeName(rawName);
  const key = STORE_PREFIX + reviewerId;
  session = store.get(key);
  if (!session || session.itemsVersion !== DATA.items_version) {
    session = {
      schema: SCHEMA,
      reviewer: rawName.trim(),
      reviewerId,
      itemsVersion: DATA.items_version,
      appVersion: APP_VERSION,
      startedAt: new Date().toISOString(),
      queue: buildQueue(reviewerId),
      reviews: {},
      skipped: [],
      seenMilestone: false,
    };
  }
  session.reviewer = rawName.trim();
  persist();
  store.set(LAST_KEY, { reviewerId });
  $('who').textContent = session.reviewer;
  cursor = firstUnanswered();
  show('review');
  renderItem();
}

function persist() {
  if (!session) return;
  const ok = store.set(STORE_PREFIX + session.reviewerId, session);
  if (!ok) fatal('Could not save to this browser. Download your reviews now so nothing is lost.');
}

function firstUnanswered() {
  const i = session.queue.findIndex(
    (id) => !session.reviews[id] && !session.skipped.includes(id));
  return i === -1 ? session.queue.length : i;
}

function nReviewed() {
  return Object.keys(session.reviews).length;
}

/* ── rendering ──────────────────────────────────────────────────────────── */
function renderItem() {
  clearTimeout(advanceTimer);
  if (cursor >= session.queue.length) return renderDone();

  const id = session.queue[cursor];
  const item = byId.get(id);
  if (!item) { cursor++; return renderItem(); }

  stage = 1;
  draft = { leak: null, helpful: null };
  stageEnteredAt = performance.now();
  stage1Ms = 0;

  renderTally();
  $('question').textContent = item.question;

  const ul = $('choices');
  ul.textContent = '';
  item.choices.forEach((c, i) => {
    const li = document.createElement('li');
    li.dataset.idx = String(i);
    const letter = document.createElement('span');
    letter.className = 'letter';
    letter.textContent = 'ABCD'[i] + '.';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = c;
    li.append(letter, text);
    ul.append(li);
  });

  renderTurns($('dialogue-stage1'), item.dialogue.slice(0, 1));
  $('dialogue-rest').textContent = '';

  const prev = session.reviews[id];
  $('reply').value = prev ? prev.student_reply : '';
  $('note').value = prev ? prev.note : '';
  $('note-wrap').open = !!(prev && prev.note);
  $('reply-error').hidden = true;

  $('stage1').hidden = false;
  $('stage2').hidden = true;

  window.scrollTo({ top: 0, behavior: 'auto' });
  $('reply').focus({ preventScroll: true });
}

/* Contribution, never a denominator. */
function renderTally() {
  const n = nReviewed();
  $('tally').textContent = n === 0
    ? 'First one below — thank you for doing this'
    : `${n} reviewed — thank you!`;
}

let bannerTimer = null;
function showBanner(text) {
  $('banner-text').textContent = text;
  $('banner').hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { $('banner').hidden = true; }, 14000);
}

function renderTurns(container, turns) {
  container.textContent = '';
  for (const t of turns) {
    const div = document.createElement('div');
    div.className = 'turn turn-' + (t.role === 'tutor' ? 'tutor' : 'student');
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = t.role === 'tutor' ? 'Tutor' : 'Student';
    const p = document.createElement('p');
    p.textContent = t.text;
    div.append(role, p);
    container.append(div);
  }
}

function goStage2() {
  const reply = $('reply').value.trim();
  if (reply.length < 2) {
    const e = $('reply-error');
    e.textContent = 'Write something first — even "idk" is a real answer.';
    e.hidden = false;
    $('reply').focus();
    return;
  }
  $('reply-error').hidden = true;
  stage1Ms = Math.round(performance.now() - stageEnteredAt);
  stage = 2;
  stageEnteredAt = performance.now();

  const item = byId.get(session.queue[cursor]);
  const goldIdx = parseInt(atob(item.gold_b64), 10);

  // Reveal: marked with a check glyph and a text label, not colour alone.
  $('choices').querySelectorAll('li').forEach((li) => {
    if (Number(li.dataset.idx) === goldIdx) {
      li.classList.add('is-gold');
      const tag = document.createElement('span');
      tag.className = 'gold-tag';
      tag.textContent = 'correct answer';
      li.append(tag);
    }
  });

  $('your-reply').textContent = '“' + reply + '”';
  renderTurns($('dialogue-rest'), item.dialogue.slice(1));
  renderOpts();

  $('stage1').hidden = true;
  $('stage2').hidden = false;
  // Move focus off the (now hidden) reply box, otherwise the number-key shortcuts
  // are swallowed as typing and screen readers stay parked in stage 1.
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  $('stage2').focus({ preventScroll: true });

  const prev = session.reviews[item.id];
  if (prev) {
    draft = { leak: prev.leak, helpful: prev.helpful };
    syncOpts();
  }
  updateNextState();
  // Instant, and to the top: the revealed answer sits just under the question, so
  // scrolling further down would skip past the thing we just revealed. A smooth
  // scroll also leaves a window where taps land on whatever slid under the finger.
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function renderOpts() {
  buildGroup($('opts-leak'), LEAK_OPTS, 'leak');
  buildGroup($('opts-help'), HELP_OPTS, 'helpful');
  syncOpts();
}

function buildGroup(container, opts, field) {
  container.textContent = '';
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.dataset.value = o.value;
    b.dataset.field = field;

    const title = document.createElement('span');
    title.className = 'opt-title';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = o.title;
    title.append(mark, label);

    const sub = document.createElement('span');
    sub.className = 'opt-sub';
    sub.textContent = o.sub;

    const key = document.createElement('span');
    key.className = 'key';
    key.setAttribute('aria-hidden', 'true');
    key.textContent = o.key;

    b.append(title, sub, key);
    b.addEventListener('click', () => choose(field, o.value));
    container.append(b);
  }
}

function choose(field, value) {
  draft[field] = value;
  syncOpts();
  updateNextState();
  maybeAutoAdvance();
}

function syncOpts() {
  document.querySelectorAll('.opt').forEach((b) => {
    b.setAttribute('aria-checked', String(draft[b.dataset.field] === b.dataset.value));
  });
}

function updateNextState() {
  $('btn-s2-next').disabled = !(draft.leak && draft.helpful);
}

function maybeAutoAdvance() {
  clearTimeout(advanceTimer);
  if (!(draft.leak && draft.helpful)) return;
  if (document.activeElement === $('note') || $('note').value.trim()) return;
  advanceTimer = setTimeout(() => { if (stage === 2) saveAndNext(); }, AUTO_ADVANCE_MS);
}

function saveAndNext() {
  clearTimeout(advanceTimer);
  if (!(draft.leak && draft.helpful)) return;
  const id = session.queue[cursor];
  session.reviews[id] = {
    item_id: id,
    order_index: cursor,
    in_shared_set: DATA.overlap_ids.includes(id),
    student_reply: $('reply').value.trim(),
    leak: draft.leak,
    helpful: draft.helpful,
    note: $('note').value.trim(),
    stage1_ms: stage1Ms,
    stage2_ms: Math.round(performance.now() - stageEnteredAt),
    submitted_at: new Date().toISOString(),
  };
  session.skipped = session.skipped.filter((s) => s !== id);

  // The shared set is the part we cannot do without, so say thank you the moment
  // it is finished - and say plainly that stopping there is a complete answer.
  const sharedDone = DATA.overlap_ids.every((oid) => session.reviews[oid]);
  if (sharedDone && !session.seenMilestone) {
    session.seenMilestone = true;
    showBanner('That is the shared set done — the part we most need. ' +
               'Stop here with a clear conscience, or keep going as long as you like.');
  }

  persist();
  cursor++;
  renderItem();
}

function skipItem() {
  const id = session.queue[cursor];
  if (!session.reviews[id] && !session.skipped.includes(id)) session.skipped.push(id);
  persist();
  cursor++;
  renderItem();
}

function goBack() {
  clearTimeout(advanceTimer);
  if (stage === 2) { renderItem(); return; }   // back out of stage 2 to stage 1
  if (cursor > 0) { cursor--; renderItem(); }
}

/* Only reached by exhausting the entire pool — there is no target to "finish". */
function renderDone() {
  const done = nReviewed();
  const skipped = session.skipped.length;
  renderTally();
  $('done-summary').textContent =
    `You reviewed ${done} dialogues` +
    (skipped ? `, and skipped ${skipped}.` : ' — the whole pool.') +
    ' That is genuinely useful: the leak labels have never been checked against a ' +
    'human before, and yours are the first.';
  $('btn-review-again').hidden = skipped === 0;
  show('done');
  if (SUBMIT_URL) trySubmit();
}

/* ── export ─────────────────────────────────────────────────────────────── */
function buildPayload() {
  const reviews = session.queue.map((id) => session.reviews[id]).filter(Boolean);
  return {
    schema: SCHEMA,
    app_version: APP_VERSION,
    items_version: session.itemsVersion,
    reviewer: session.reviewer,
    reviewer_id: session.reviewerId,
    started_at: session.startedAt,
    exported_at: new Date().toISOString(),
    user_agent: navigator.userAgent,
    n_completed: reviews.length,
    n_skipped: session.skipped.length,
    skipped_ids: session.skipped.slice(),
    shared_set_ids: DATA.overlap_ids.slice(),
    shared_set_completed: DATA.overlap_ids.every((id) => !!session.reviews[id]),
    reviews,
  };
}

function download() {
  if (!session) return;
  const payload = buildPayload();
  if (payload.n_completed === 0) {
    setStatus('Nothing to download yet — review at least one item first.', true);
    showBanner('Nothing to download yet — finish one dialogue first.');
    return;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  a.href = url;
  a.download = `tutor-review_${session.reviewerId.replace(/[^a-z0-9]+/g, '-')}_${stamp}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  const msg = `Downloaded ${payload.n_completed} review${payload.n_completed === 1 ? '' : 's'}. ` +
    'Send that file to Sophia and you are done — or carry on, and download again later ' +
    '(the file always contains everything).';
  setStatus(msg);
  showBanner('✓ ' + msg);
}

async function trySubmit() {
  // Only runs when SUBMIT_URL is set; the download is always the fallback.
  try {
    const res = await fetch(SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    setStatus(res.ok ? 'Sent automatically — you can still download a copy.'
                     : 'Automatic send failed. Please use the download button.', !res.ok);
  } catch {
    setStatus('Automatic send failed. Please use the download button.', true);
  }
}

function setStatus(msg, isError) {
  const el = $('submit-status');
  el.textContent = (isError ? '⚠ ' : '✓ ') + msg;
  el.style.color = isError ? 'var(--danger)' : 'var(--tutor)';
}

/* ── handlers ───────────────────────────────────────────────────────────── */
function wireStaticHandlers() {
  $('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('name').value;
    if (normalizeName(v).length < 2) {
      const err = $('name-error');
      err.textContent = 'Please enter at least two characters.';
      err.hidden = false;
      return;
    }
    $('name-error').hidden = true;
    startSession(v);
  });

  $('btn-s1-next').addEventListener('click', goStage2);
  $('btn-skip').addEventListener('click', skipItem);
  $('btn-s2-next').addEventListener('click', saveAndNext);
  $('btn-back').addEventListener('click', goBack);
  $('btn-download-top').addEventListener('click', download);
  $('btn-download-done').addEventListener('click', download);

  $('btn-review-again').addEventListener('click', () => {
    session.queue = session.queue.concat(session.skipped);
    session.skipped = [];
    persist();
    cursor = firstUnanswered();
    show('review');
    renderItem();
  });

  $('banner-close').addEventListener('click', () => { $('banner').hidden = true; });

  $('btn-reset').addEventListener('click', () => {
    if (!confirm('Erase all your answers on this device and start over?')) return;
    store.del(STORE_PREFIX + session.reviewerId);
    store.del(LAST_KEY);
    location.reload();
  });

  // Enter sends the stage-1 reply; Shift+Enter makes a newline.
  $('reply').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); goStage2(); }
  });
  $('note').addEventListener('focus', () => clearTimeout(advanceTimer));
  $('note-wrap').addEventListener('toggle', () => clearTimeout(advanceTimer));

  document.addEventListener('keydown', (e) => {
    if (stage !== 2 || $('screen-review').hidden) return;
    const active = document.activeElement || document.body;
    const typing = ['TEXTAREA', 'INPUT'].includes(active.tagName) && active.offsetParent !== null;
    if (e.key === 'Escape') { clearTimeout(advanceTimer); return; }
    if (typing) return;
    // Let a focused choice button handle its own Enter/Space activation, and give
    // the radiogroup the arrow-key navigation the ARIA role implies.
    if (active.classList && active.classList.contains('opt')) {
      if (e.key === 'Enter' || e.key === ' ') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' ||
          e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const sibs = [...active.parentElement.querySelectorAll('.opt')];
        const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
        const next = sibs[(sibs.indexOf(active) + step + sibs.length) % sibs.length];
        next.focus();
        choose(next.dataset.field, next.dataset.value);
        return;
      }
    }
    const leak = LEAK_OPTS.find((o) => o.key === e.key);
    const help = HELP_OPTS.find((o) => o.key === e.key);
    if (leak) { e.preventDefault(); choose('leak', leak.value); }
    else if (help) { e.preventDefault(); choose('helpful', help.value); }
    else if (e.key === 'Enter') { e.preventDefault(); saveAndNext(); }
    else if (e.key === 'Backspace') { e.preventDefault(); goBack(); }
  });
}
