'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildServer } = require('../src/server');
const { createDatabase } = require('../src/db/database');
const { launchChrome } = require('./helpers/chrome.cjs');

const PT = require('../src/public/locales/pt.json').home.onboarding;
const EN = require('../src/public/locales/en.json').home.onboarding;

async function setup(t) {
  const db = createDatabase({ filename: ':memory:' });
  const app = await buildServer({ db, sessionCookieSecure: false, unsplashFetch: async () => { throw new Error('No external hero request in browser tests.'); } });
  const origin = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/\/$/, '');
  t.after(async () => { await app.close(); db.close(); });
  async function account({ email, language, status, steps = {} }) {
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'tour-secret-123', first_name: 'Tour', last_name: 'Runner', preferred_lang: language } });
    assert.equal(registered.statusCode, 201);
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
    db.prepare('UPDATE users SET onboarding_status = ? WHERE id = ?').run(status, userId);
    if (steps.shoes) db.prepare('INSERT INTO shoes (id, user_id, brand, model) VALUES (?, ?, ?, ?)').run(`tour-shoe-${userId}`, userId, 'Kinesis', 'Tour shoe');
    if (steps.cycle) db.prepare('INSERT INTO training_cycles (id, user_id, objective, status) VALUES (?, ?, ?, ?)').run(`tour-cycle-${userId}`, userId, 'Tour cycle', 'active');
    if (steps.trainings) db.prepare('INSERT INTO trainings (user_id, training_cycle_id, dia, tipo, treino) VALUES (?, ?, ?, ?, ?)').run(userId, steps.cycle ? `tour-cycle-${userId}` : null, '2026-11-12', 'Run', 'Tour workout');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'tour-secret-123' } });
    assert.equal(login.statusCode, 200);
    const cookie = [].concat(login.headers['set-cookie'])[0].split(';')[0].split('=')[1];
    return { userId, cookie, onboarding: () => db.prepare('SELECT onboarding_status AS status, onboarding_guide_hidden AS hidden FROM users WHERE id = ?').get(userId) };
  }
  return { db, app, origin, account };
}

async function openPage(browser, origin, cookie, url, { width, height, mobile, language }) {
  const { command, wait, evaluate } = browser;
  await command('Network.clearBrowserCookies');
  await command('Network.setCookie', { name: 'ta_session', value: cookie, url: origin, httpOnly: true });
  await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await command('Page.navigate', { url: origin + url });
  await wait("document.body.classList.contains('shell-mounted') && !!document.querySelector('.lang-switch')");
  if (language) {
    await evaluate(`document.querySelector('.lang-switch [data-lang="${language}"]').click()`);
    await wait(`document.documentElement.lang === '${language}'`);
  }
}

const tourState = `(() => {
  const tour = document.getElementById('onboardingTour');
  const video = document.getElementById('onboardingTourVideo');
  const card = tour.querySelector('[role="dialog"]').getBoundingClientRect();
  const action = document.getElementById('onboardingTourAction');
  return {
    open: !tour.hidden,
    focused: document.activeElement?.id || document.activeElement?.tagName,
    backgroundInert: [...document.body.children].filter((node) => node !== tour && node.tagName !== 'SCRIPT').every((node) => node.inert),
    sources: [...video.querySelectorAll('source')].map((node) => node.getAttribute('src').split('?')[0]),
    track: (() => { const track = video.querySelector('track'); return track && { kind: track.kind, srclang: track.srclang, label: track.label, isDefault: track.default, src: track.getAttribute('src').split('?')[0] }; })(),
    poster: video.getAttribute('poster')?.split('?')[0] ?? null,
    transcript: [...document.querySelectorAll('#onboardingTourTranscript li')].map((li) => li.textContent),
    footerVisible: !document.getElementById('onboardingTourFooter').hidden,
    later: Boolean(document.getElementById('onboardingLater')),
    action: document.getElementById('onboardingTourFooter').hidden ? null : { text: action.textContent, href: action.getAttribute('href') },
    title: document.getElementById('onboardingTourTitle').textContent,
    videoLabel: video.getAttribute('aria-label'),
    cardInViewport: card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight,
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
})()`;

test('Chrome: a new account gets the narrated tour, can switch language mid-video, and dismissal persists', async (t) => {
  const { origin, account } = await setup(t);
  const browser = await launchChrome(t);
  const { command, evaluate, wait, key } = browser;
  const { TOUR_MEDIA } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding-tour-media.js')));
  const { mapTourTime, TOUR_SCENES } = await import(pathToFileURL(path.join(__dirname, '../src/public/shared/onboarding.js')));
  let presentationWrites = 0;
  browser.socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.endsWith('/api/onboarding/presentation')) presentationWrites += 1;
  });
  const runner = await account({ email: 'tour-new@example.com', language: 'pt-BR', status: 'new' });
  await openPage(browser, origin, runner.cookie, '/home.html', { width: 1280, height: 800, mobile: false });
  await wait("!document.getElementById('onboardingTour').hidden && document.activeElement?.id === 'onboardingTourTitle'");
  const opened = await evaluate(tourState);
  assert.equal(opened.open, true);
  assert.equal(opened.focused, 'onboardingTourTitle', 'focus starts on the dialog heading');
  assert.equal(opened.backgroundInert, true, 'the dashboard behind the dialog is inert');
  assert.equal(opened.title, PT.tourTitle);
  assert.equal(opened.videoLabel, PT.videoLabel);
  assert.deepEqual(opened.sources, ['/assets/onboarding/tour/kinesis-tour-pt.webm', '/assets/onboarding/tour/kinesis-tour-pt.mp4']);
  assert.deepEqual(opened.track, { kind: 'captions', srclang: 'pt-BR', label: 'Português (Brasil)', isDefault: true, src: '/assets/onboarding/tour/kinesis-tour-pt.vtt' });
  assert.equal(opened.poster, '/assets/onboarding/tour/kinesis-tour-pt-poster.jpg');
  assert.equal(opened.transcript.length, TOUR_SCENES.length);
  assert.equal(opened.transcript[0], `${PT.tour.cues.intro1} ${PT.tour.cues.intro2}`);
  assert.equal(opened.footerVisible, true);
  assert.equal(opened.later, false, 'there is no redundant Not now button; the header button closes');
  assert.deepEqual(opened.action, { text: PT.shoesAction, href: '/shoes.html' });
  assert.equal(opened.cardInViewport, true);
  assert.equal(opened.overflow, false);
  assert.equal(presentationWrites, 0, 'opening the tour writes nothing');
  assert.equal(await evaluate("document.getElementById('onboardingTourVideo').autoplay"), false);

  // The real media and captions load from the server.
  await wait("document.getElementById('onboardingTourVideo').readyState >= 1 && document.getElementById('onboardingTourVideo').textTracks[0]?.cues?.length > 0");
  const media = await evaluate("(() => { const v = document.getElementById('onboardingTourVideo'); return { duration: v.duration, cues: v.textTracks[0].cues.length, mode: v.textTracks[0].mode, first: v.textTracks[0].cues[0].text }; })()");
  assert.ok(Math.abs(media.duration - TOUR_MEDIA.pt.duration) < 0.5, 'the Portuguese video duration matches the manifest');
  assert.equal(media.cues, TOUR_SCENES.flatMap((scene) => scene.cues).length);
  assert.equal(media.mode, 'showing', 'captions are on by default');
  assert.equal(media.first, PT.tour.cues.intro1);

  // Keyboard containment: Shift+Tab from the first control wraps to the last.
  await evaluate("document.getElementById('onboardingTourClose').focus()");
  await key('Tab', 'Tab', 9, 8);
  assert.equal(await evaluate('document.activeElement.id'), 'onboardingTourAction');
  await key('Tab', 'Tab', 9);
  assert.equal(await evaluate('document.activeElement.id'), 'onboardingTourClose');

  // Switching language while open swaps media and keeps the same point of the scene.
  await evaluate("document.getElementById('onboardingTourVideo').currentTime = 20");
  await wait("Math.abs(document.getElementById('onboardingTourVideo').currentTime - 20) < 0.1");
  await command('Runtime.evaluate', { expression: "(() => { const button = document.querySelector('.lang-switch [data-lang=\"en-US\"]'); button.click(); })()" });
  await wait("document.documentElement.lang === 'en-US' && document.getElementById('onboardingTourVideo').currentSrc.includes('kinesis-tour-en') && document.getElementById('onboardingTourVideo').readyState >= 1 && document.getElementById('onboardingTourVideo').currentTime > 1");
  const switched = await evaluate(tourState);
  assert.equal(switched.open, true, 'a language change keeps the tour open');
  assert.equal(switched.title, EN.tourTitle);
  assert.deepEqual(switched.track, { kind: 'captions', srclang: 'en', label: 'English', isDefault: true, src: '/assets/onboarding/tour/kinesis-tour-en.vtt' });
  assert.equal(switched.transcript[1], `${EN.tour.cues.shoes1} ${EN.tour.cues.shoes2}`);
  assert.deepEqual(switched.action, { text: EN.shoesAction, href: '/shoes.html' });
  const resumed = await evaluate("document.getElementById('onboardingTourVideo').currentTime");
  assert.ok(Math.abs(resumed - mapTourTime(TOUR_MEDIA.pt.scenes, TOUR_MEDIA.en.scenes, 20)) < 0.2, 'the English video resumes at the equivalent scene position');
  assert.equal(await evaluate("document.querySelectorAll('#onboardingTourVideo track').length"), 1, 'no stale caption track remains');

  // Escape closes, persists the dismissal once, releases the page and restores focus.
  await key('Escape', 'Escape', 27);
  await wait("document.getElementById('onboardingTour').hidden");
  await wait("document.activeElement?.id === 'userBadge'");
  const closed = await evaluate(tourState);
  assert.equal(closed.backgroundInert, false);
  assert.equal(await evaluate("document.getElementById('onboardingTourVideo').paused"), true);
  assert.equal(presentationWrites, 1);
  assert.equal(runner.onboarding().status, 'active', 'dismissal moves the account out of first-visit status');

  await openPage(browser, origin, runner.cookie, '/home.html', { width: 390, height: 844, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await evaluate("document.getElementById('onboardingTour').hidden"), true, 'the dismissed tour does not reopen on reload');
});

test('Chrome: the user menu opens the tour for existing accounts without writing state, from any page and viewport', async (t) => {
  const { origin, account } = await setup(t);
  const browser = await launchChrome(t);
  const { command, evaluate, wait, key } = browser;
  let presentationWrites = 0;
  browser.socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.endsWith('/api/onboarding/presentation')) presentationWrites += 1;
  });
  const openFromMenu = async () => {
    await evaluate("document.getElementById('userBadge').click()");
    await wait("!document.getElementById('userDropdown').classList.contains('hidden')");
    await evaluate("document.getElementById('userSetupGuide').click()");
  };

  // Existing EN account with shoes, mobile: no automatic tour; menu opens it.
  const existing = await account({ email: 'tour-existing@example.com', language: 'en-US', status: 'active', steps: { shoes: true } });
  await openPage(browser, origin, existing.cookie, '/home.html', { width: 390, height: 844, mobile: true, language: 'en-US' });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await evaluate("document.getElementById('onboardingTour').hidden"), true, 'existing accounts are not interrupted');
  assert.equal(await evaluate("document.getElementById('userSetupGuide').innerText.trim()"), 'Welcome tour');
  await openFromMenu();
  await wait("!document.getElementById('onboardingTour').hidden && document.activeElement?.id === 'onboardingTourTitle'");
  const mobile = await evaluate(tourState);
  assert.deepEqual(mobile.action, { text: EN.cycleAction, href: '/cycles.html' });
  assert.equal(mobile.overflow, false, 'no horizontal page scroll on mobile');
  assert.equal(await evaluate("document.getElementById('userDropdown').classList.contains('hidden')"), true, 'the menu closes');
  const player = await evaluate("(() => { const r = document.querySelector('.onboarding-tour-player').getBoundingClientRect(); return { width: r.width, ratio: r.width / r.height }; })()");
  assert.ok(player.width > 300 && Math.abs(player.ratio - 16 / 9) < 0.05, 'the player keeps a 16:9 frame on mobile');
  await evaluate("document.getElementById('onboardingTourClose').click()");
  await wait("document.getElementById('onboardingTour').hidden");
  await wait("document.activeElement?.id === 'feedbackTrigger'");
  assert.equal(await evaluate('document.activeElement.getClientRects().length > 0'), true, 'focus returns to a visible topbar control on phones, where the account badge is hidden');
  assert.equal(presentationWrites, 0, 'closing an explicitly opened tour for an existing account writes nothing');
  assert.deepEqual(existing.onboarding(), { status: 'active', hidden: 0 });

  // Complete PT account at a reduced height, opened from another page: no step action.
  const complete = await account({ email: 'tour-complete@example.com', language: 'pt-BR', status: 'active', steps: { shoes: true, cycle: true, trainings: true } });
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await openPage(browser, origin, complete.cookie, '/shoes.html?keep=1#top', { width: 1280, height: 560, mobile: false, language: 'pt-BR' });
  await openFromMenu();
  await wait("location.pathname === '/home.html' && !document.getElementById('onboardingTour').hidden");
  assert.equal(await evaluate('location.search + location.hash'), '?keep=1#top', 'the transient signal is consumed and other parameters kept');
  const short = await evaluate(tourState);
  assert.equal(short.footerVisible, false, 'a complete setup shows no footer at all');
  assert.equal(short.action, null, 'a complete setup has no step action');
  await evaluate("document.getElementById('onboardingTourClose').focus()");
  await key('Tab', 'Tab', 9, 8);
  assert.equal(await evaluate("document.activeElement.tagName"), 'SUMMARY', 'without a footer Shift+Tab wraps to the transcript toggle');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.onboarding-tour-card')).animationName"), 'none', 'reduced motion removes the dialog animation');
  const reach = await evaluate("(() => { const card = document.querySelector('.onboarding-tour-card'); const last = card.querySelector('summary'); last.scrollIntoView({ block: 'nearest' }); const r = last.getBoundingClientRect(); return { scrolls: card.scrollHeight > card.clientHeight, visible: r.top >= 0 && r.bottom <= innerHeight }; })()");
  assert.equal(reach.scrolls, true, 'the dialog scrolls inside a short viewport');
  assert.equal(reach.visible, true, 'the last control stays reachable');
  await evaluate("document.getElementById('onboardingTour').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  await wait("document.getElementById('onboardingTour').hidden");
  assert.equal(presentationWrites, 0);
});

test('Chrome: the tour action records the dismissal for a new account before navigating', async (t) => {
  const { origin, account } = await setup(t);
  const browser = await launchChrome(t);
  const { evaluate, wait } = browser;
  const runner = await account({ email: 'tour-action@example.com', language: 'en-US', status: 'new', steps: { shoes: true, cycle: true } });
  await openPage(browser, origin, runner.cookie, '/home.html', { width: 1280, height: 800, mobile: false, language: 'en-US' });
  await wait("!document.getElementById('onboardingTour').hidden && document.getElementById('onboardingTourAction').getAttribute('href') === '/ai-coach.html'");
  assert.equal(await evaluate("document.getElementById('onboardingTourAction').textContent"), EN.planAction, 'with an active cycle the workouts step opens Request Workouts');
  await evaluate("document.getElementById('onboardingTourAction').click()");
  await wait("location.pathname === '/ai-coach.html'");
  assert.equal(runner.onboarding().status, 'active');
});
