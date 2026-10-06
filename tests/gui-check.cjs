'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {chromium, webkit, firefox} = require('playwright');
const root = path.resolve(__dirname, '..');
const screenshots = process.env.SCREENSHOT_DIR || path.join(os.tmpdir(), 'connoisseure-ui-checks');
const widths = [320, 375, 390, 768, 1024, 1440];
const categories = ['food', 'service', 'ambience', 'value_for_money'];
const longName = 'Alexandertheodor Maximilian von der langen Tafel';
const longRestaurant = 'Restaurant Zum außerordentlich köstlichen Abendessen & Freunde';
const longComment = 'Sehr gutes Essen, freundlicher Service und ein gemütlicher Abend. '.repeat(16) + 'WortOhneTrennzeichen'.repeat(18);
const makeReview = (meal_id, member_id, values, comment = '') => ({
  meal_id, member_id, ...Object.fromEntries(categories.map((key, index) => [key, values[index]])),
  comment, rated_at: '2026-10-04T18:00:00Z'
});
const makeMeal = (id, status, creator = 'm1', name = longRestaurant) => ({
  id, status, creator_member_id: creator, restaurant_name: name, place: 'Berlin · Lange Straße 123, Hinterhof links',
  note: 'Gemeinsam genießen. '.repeat(8), created_at: '2026-10-01T12:00:00Z',
  completed_at: status === 'completed' ? '2026-10-04T18:00:00Z' : null
});
function data() {
  return {
    members: Array.from({length: 12}, (_, index) => ({
      id: `m${index + 1}`, display_name: index === 0 ? longName : index === 1 ? 'Bea'
        : index === 11 ? 'MitgliedOhneTrennzeichen'.repeat(4).slice(0, 80) : `Mitglied ${index + 1} mit langem Vornamen`,
      is_active: true, created_at: '2026-10-01T12:00:00Z'
    })),
    meals: [makeMeal('waiting', 'waiting'), makeMeal('other-waiting', 'waiting', 'm2'),
      makeMeal('running', 'running', 'm2'), makeMeal('not-selected', 'running', 'm2'),
      makeMeal('completed', 'completed'), makeMeal('tied', 'completed', 'm2', 'Andere Empfehlung'),
      makeMeal('solo', 'completed', 'm3', 'Nur der Ersteller')],
    meal_participants: [
      ...Array.from({length: 12}, (_, index) => ({meal_id: 'running', member_id: `m${index + 1}`})),
      {meal_id: 'not-selected', member_id: 'm2'},
      {meal_id: 'completed', member_id: 'm1'}, {meal_id: 'completed', member_id: 'm2'},
      {meal_id: 'tied', member_id: 'm1'}, {meal_id: 'solo', member_id: 'm3'}
    ],
    ratings: [makeReview('completed', 'm1', [5, 5, 5, 5], longComment),
      makeReview('completed', 'm2', [0, 0.5, 5, 2.5], longComment),
      makeReview('tied', 'm1', [0, 0.5, 5, 2.5]),
      makeReview('solo', 'm3', [5, 5, 5, 5])]
  };
}

let browser;
let server;
let checks = 0;
let fixtureSessions = 0;
let screenshotCount = 0;
const failures = [];
const pageErrors = [];
async function check(name, run) {
  if (process.env.FOCUS_ONLY && !name.startsWith('focus marking')) return;
  if (process.env.CHECK_FILTER && !name.includes(process.env.CHECK_FILTER)) return;
  try { await run(); checks += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push({name, error: error.stack}); console.error(`FAIL ${name}\n${error.stack}`); }
}
async function open({width = 390, db = data(), options = {}, member = 'm1', storage = {}} = {}) {
  fixtureSessions += 1;
  const context = await browser.newContext({
    viewport: {width, height: 900}, reducedMotion: 'reduce',
    isMobile: width < 768 && process.env.BROWSER_ENGINE !== 'firefox', hasTouch: width < 1024
  });
  const page = await context.newPage();
  const searches = [];
  const photonRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(({db, options, member, storage}) => {
    window.__fixtureData = db;
    window.__fixtureOptions = options;
    if (member) localStorage.setItem('connoisseure.member-id', member);
    Object.entries(storage).forEach(([key, value]) => localStorage.setItem(key, value));
  }, {db, options, member, storage});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.openstreetmap.org' && url.pathname === '/export/embed.html') {
      return route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Fixture map</title>'});
    }
    if (url.hostname === 'photon.komoot.io' && url.pathname === '/api/') {
      photonRequests.push({url: url.href, at: Date.now()});
      const features = Array.from({length: 2}, (_, index) => ({
        type: 'Feature',
        properties: {
          name: `Photon Restaurant ${index + 1}`,
          street: `Photon Straße`,
          housenumber: `${index + 1}`,
          postcode: '10115',
          city: 'Berlin',
          country: 'Deutschland'
        },
        geometry: {type: 'Point', coordinates: [13.4 + index * 0.01, 52.5 + index * 0.01]}
      }));
      return route.fulfill({contentType: 'application/geo+json', body: JSON.stringify({type: 'FeatureCollection', features})});
    }
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'cdn.jsdelivr.net') {
      return route.fulfill({contentType: 'application/javascript', body: await fs.readFile(path.join(__dirname, 'supabase-fixture.js'), 'utf8')});
    }
    if (url.hostname === 'nominatim.openstreetmap.org') {
      searches.push({url: url.href, at: Date.now()});
      const status = url.searchParams.get('q').includes('429') ? 429 : url.searchParams.get('q').includes('503') ? 503 : 200;
      const body = Array.from({length: 5}, (_, index) => ({name: `Lokales Restaurant ${index + 1}`,
        display_name: `Lokales Restaurant ${index + 1}, Berlin, Deutschland`, lat: '52.5', lon: '13.4'}));
      return route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
    }
    throw new Error(`Unexpected external request blocked: ${url.href}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/Connoisseure/`);
  if (!options.signedOut) await page.locator(member ? 'body.is-authenticated' : '#memberScreen:not([hidden])').waitFor();
  return {context, page, searches, photonRequests};
}
async function navigate(page, view) {
  const button = page.locator(`[data-view="${view}"]:visible`);
  await button.click();
  await page.locator(`#${view}.active`).waitFor();
}
async function screenshot(page, name) {
  await page.screenshot({path: path.join(screenshots, `${name}.png`), fullPage: !(await page.locator('dialog[open]').count())});
  screenshotCount += 1;
}
async function geometry(page, label, {dialog = false} = {}) {
  const result = await page.evaluate(dialog => {
    const scope = dialog ? document.querySelector('dialog[open]') : document.body;
    const visible = element => Boolean(element.getClientRects().length);
    const viewport = document.documentElement.clientWidth;
    const overflowing = [...scope.querySelectorAll('*')].filter(element => {
      if (!visible(element) || element.matches('svg, svg *, .star-fill')) return false;
      const box = element.getBoundingClientRect();
      const textControl = element.matches('input, textarea, select');
      const inline = getComputedStyle(element).display === 'inline';
      return box.left < -1 || box.right > viewport + 1 || (!textControl && !inline && element.scrollWidth > element.clientWidth + 2);
    }).map(element => `${element.tagName}.${element.className?.baseVal ?? element.className}`);
    const controls = [...document.querySelectorAll(dialog ? 'dialog[open] button, dialog[open] input:not([type="checkbox"]), dialog[open] textarea' : 'button, summary')]
      .filter(visible);
    const smallControls = controls.filter(element => {
      const box = element.getBoundingClientRect();
      return box.width < 43.5 || box.height < 43.5;
    }).map(element => element.outerHTML.slice(0, 160));
    const uncentered = controls.filter(element => element.tagName === 'BUTTON').filter(element => {
      const css = getComputedStyle(element);
      return css.justifyContent !== 'center' || css.alignItems !== 'center';
    }).map(element => element.outerHTML.slice(0, 120));
    const clippedActions = dialog ? [...scope.querySelectorAll('.modal-footer button')].filter(element => {
      const box = element.getBoundingClientRect();
      return box.bottom > innerHeight + 1 || box.top < 0;
    }).length : 0;
    return {pageWidth: document.documentElement.scrollWidth, viewport, overflowing, smallControls, uncentered, clippedActions};
  }, dialog);
  if (result.pageWidth !== result.viewport || result.overflowing.length) await screenshot(page, `${label.replaceAll(' ', '-')}-overflow`);
  assert.equal(result.pageWidth, result.viewport, `${label}: page overflow (${JSON.stringify(result)})`);
  assert.deepEqual(result.overflowing, [], `${label}: component overflow`);
  assert.deepEqual(result.smallControls, [], `${label}: touch targets`);
  assert.deepEqual(result.uncentered, [], `${label}: button centering`);
  assert.equal(result.clippedActions, 0, `${label}: concealed modal actions`);
}
async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({state: 'hidden'});
  await page.waitForFunction(() => !document.body.classList.contains('modal-open'));
}
async function changeMember(page, member) {
  const account = page.locator('.mobile-header:visible');
  if (await account.count()) await page.locator('.account-menu summary').click();
  await page.locator('[data-account-action="change"]:visible').click();
  await page.selectOption('#memberSelect', member);
  await page.click('#chooseMember');
  await page.locator('body.is-authenticated').waitFor();
}
async function rateAll(page, value) {
  for (const category of categories) {
    const row = page.locator(`[data-rating="${category}"]`);
    await row.locator('[tabindex="0"]').focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < value * 2; i += 1) await page.keyboard.press('ArrowRight');
  }
}

(async () => {
  await fs.mkdir(screenshots, {recursive: true});
  server = http.createServer(async (request, response) => {
    const files = {'/Connoisseure/': 'index.html', '/Connoisseure/app.js': 'app.js', '/Connoisseure/styles.css': 'styles.css', '/Connoisseure/chevron.svg': 'chevron.svg'};
    const file = files[new URL(request.url, 'http://localhost').pathname];
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    response.end(await fs.readFile(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = process.env.BROWSER_ENGINE === 'webkit'
    ? await webkit.launch()
    : process.env.BROWSER_ENGINE === 'firefox'
    ? await firefox.launch()
    : await chromium.launch({channel: process.env.BROWSER_CHANNEL || 'msedge'});

  for (const width of [390, 1440]) {
    await check(`focus marking is absent on automatic/pointer focus; keyboard feedback at ${width}px`, async () => {
      const {page, context} = await open({width});
      const appearance = locator => locator.evaluate(element => {
        const css = getComputedStyle(element);
        return {
          outline: css.outlineStyle, shadow: css.boxShadow, background: css.backgroundColor,
          underline: css.textDecorationLine, border: css.borderColor
        };
      });
      const noFrame = state => {
        assert.equal(state.outline, 'none', 'focused element must have no marking outline');
        assert.equal(state.shadow, 'none', 'focused element must have no focus halo');
      };
      try {
        await page.bringToFront();
        await page.locator('#dashboardTitle').focus();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'dashboardTitle');
        const heading = await appearance(page.locator('#dashboardTitle'));
        await screenshot(page, `${width}-focus-initial`);
        await page.locator('[data-action="start"][data-id="waiting"]').click();
        const first = page.locator('#memberPicker input').first();
        assert.ok(await first.evaluate(element => element === document.activeElement));
        const automatic = await appearance(first);
        await screenshot(page, `${width}-focus-start-untouched`);
        noFrame(heading);
        noFrame(automatic);
        assert.equal(await first.locator('..').locator('span').last().evaluate(element => getComputedStyle(element).textDecorationLine), 'none');
        assert.deepEqual(await page.locator('#memberPicker input:checked').evaluateAll(elements => elements.map(element => element.value)), ['m1']);
        await page.keyboard.press('Space');
        assert.ok(!await first.isChecked());
        await page.keyboard.press('Space');
        assert.ok(await first.isChecked());
        noFrame(await appearance(first));
        assert.match(await first.locator('..').locator('span').last().evaluate(element => getComputedStyle(element).textDecorationLine), /underline/);
        await page.keyboard.press('Tab');
        noFrame(await appearance(page.locator('#memberPicker input').nth(1)));
        await closeDialog(page);
        noFrame(await appearance(page.locator('[data-action="start"][data-id="waiting"]')));
        await page.click('#openCreate');
        const query = page.locator('#restaurantSearchQuery');
        const defaultField = await appearance(query);
        assert.ok(!await page.locator('body').evaluate(body => body.classList.contains('keyboard-navigation')));
        noFrame(defaultField);
        await query.click();
        assert.deepEqual(await appearance(query), defaultField, 'pointer focus must not decorate fields');
        await page.keyboard.press('Tab');
        noFrame(await appearance(page.locator('#restaurantSearchButton')));
        assert.match((await appearance(page.locator('#restaurantSearchButton'))).underline, /underline/);
        await page.keyboard.press('Shift+Tab');
        const keyboardField = await appearance(query);
        assert.notEqual(keyboardField.background, defaultField.background);
        assert.equal(keyboardField.border, defaultField.border, 'normal input border must remain unchanged');
        noFrame(keyboardField);
        await closeDialog(page);
        await page.locator('[data-action="rate"][data-id="running"]').click();
        const row = page.locator('[data-rating="food"]');
        const zero = row.locator('[data-score="0"]');
        noFrame(await appearance(zero));
        await page.keyboard.press('ArrowRight');
        const star = row.locator('[data-score="1"]');
        assert.equal(await page.locator('#value-food').textContent(), '0,5 / 5');
        noFrame(await appearance(star));
        const keyboardStar = await appearance(star);
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('#value-food').textContent(), '1,0 / 5');
        await star.click({position: {x: 8, y: 22}});
        assert.equal(await page.locator('#value-food').textContent(), '0,5 / 5');
        const pointerStar = await appearance(star);
        assert.notEqual(pointerStar.background, keyboardStar.background, 'star background feedback is keyboard-only');
        noFrame(pointerStar);
        if (width < 1024) {
          const bounds = await star.boundingBox();
          await page.touchscreen.tap(bounds.x + 36, bounds.y + 22);
          assert.equal(await page.locator('#value-food').textContent(), '1,0 / 5');
          noFrame(await appearance(star));
        }
        await closeDialog(page);
        await navigate(page, 'history');
        noFrame(await appearance(page.locator('#historyTitle')));
      } finally { await context.close(); }
    });
  }

  for (const width of widths) {
    await check(`responsive views and all dialogs at ${width}px`, async () => {
      const {page, context} = await open({width});
      try {
        assert.equal(await page.locator('nav:visible').count(), 1);
        const order = await page.evaluate(() => document.querySelector('.pending-wrap').offsetTop < document.querySelector('.dashboard-summary').offsetTop);
        assert.ok(order);
        await geometry(page, `dashboard ${width}`);
        await screenshot(page, `${width}-dashboard`);
        await page.locator('[data-action="details"][data-id="completed"]').first().click();
        await geometry(page, `details ${width}`);
        if (width >= 1024) {
          const review = await page.locator('.detail-reviews').boundingBox();
          const metadata = await page.locator('.detail-secondary').boundingBox();
          assert.ok(review.width > metadata.width, 'reviews must have the wide area');
        }
        assert.equal(await page.locator('.history-result-category').count(), 8);
        assert.equal(await page.locator('.creator-badge').count(), 1);
        await screenshot(page, `${width}-details`);
        await navigate(page, 'dashboard');
        await page.locator('[data-action="details"][data-id="running"]').click();
        await geometry(page, `running details ${width}`);
        assert.equal(await page.locator('.member-list .member').count(), 12);
        await screenshot(page, `${width}-running-details`);
        await navigate(page, 'dashboard');
        await page.locator('[data-action="details"][data-id="waiting"]').click();
        await geometry(page, `waiting details ${width}`);
        await screenshot(page, `${width}-waiting-details`);
        await navigate(page, 'history');
        await geometry(page, `history ${width}`);
        await screenshot(page, `${width}-history`);
        await navigate(page, 'stats');
        await geometry(page, `stats ${width}`);
        await screenshot(page, `${width}-stats`);
        await navigate(page, 'dashboard');
        await page.click('#openCreate');
        await geometry(page, `create ${width}`, {dialog: true});
        await screenshot(page, `${width}-create`);
        await closeDialog(page);
        await page.locator('[data-action="start"][data-id="waiting"]').click();
        await geometry(page, `start ${width}`, {dialog: true});
        await screenshot(page, `${width}-start`);
        await closeDialog(page);
        await page.locator('[data-action="rate"][data-id="running"]').click();
        await rateAll(page, 2.5);
        await geometry(page, `rating ${width}`, {dialog: true});
        await screenshot(page, `${width}-rating`);
        await closeDialog(page);
        await changeMember(page, 'm2');
        if (width < 1024) await page.locator('.account-menu summary').click();
        assert.ok(await page.locator('.profile-info:visible').textContent());
        await page.locator('[data-account-action="logout"]:visible').click();
        await page.locator('#authScreen:not([hidden])').waitFor();
        await geometry(page, `login ${width}`);
        await screenshot(page, `${width}-login`);
      } finally { await context.close(); }
      const gate = await open({width, member: null});
      try {
        await geometry(gate.page, `member ${width}`);
        await screenshot(gate.page, `${width}-member`);
      } finally { await gate.context.close(); }
    });
  }

  await check('dialog title, initial focus, Tab trap, Escape, focus return, short viewport', async () => {
    const {page, context} = await open();
    try {
      await page.click('#openCreate');
      assert.equal(await page.locator('#createModal').getAttribute('aria-labelledby'), 'createTitle');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'restaurantSearchQuery');
      assert.ok(await page.locator('body').evaluate(body => getComputedStyle(body).overflow === 'hidden'));
      await page.locator('#saveCreate').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.close), 'createModal');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'saveCreate');
      await page.setViewportSize({width: 390, height: 420});
      await geometry(page, 'short viewport create', {dialog: true});
      await screenshot(page, '390-keyboard-height-create');
      await closeDialog(page);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'openCreate');
      assert.ok(await page.locator('body').evaluate(body => getComputedStyle(body).overflow !== 'hidden'));
      await page.locator('[data-action="rate"][data-id="running"]').click();
      await page.locator('#ratingComment').focus();
      await geometry(page, 'short viewport rating', {dialog: true});
      const comment = await page.locator('#ratingComment').boundingBox();
      const actions = await page.locator('#ratingModal .modal-footer').boundingBox();
      assert.ok(comment.y >= 0 && comment.y + comment.height <= actions.y + 1);
      await screenshot(page, '390-keyboard-height-rating');
      await closeDialog(page);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'rate');
    } finally { await context.close(); }
  });

  await check('all eleven half-star values in every category, pointer halves and Enter/Space', async () => {
    const {page, context} = await open({width: 320});
    try {
      await page.locator('[data-action="rate"][data-id="running"]').click();
      for (const category of categories) {
        const row = page.locator(`[data-rating="${category}"]`);
        await row.locator('[data-score="0"]').focus();
        await page.keyboard.press('Space');
        for (let step = 0; step <= 10; step += 1) {
          if (step) await page.keyboard.press('ArrowRight');
          assert.equal(await page.locator(`#value-${category}`).textContent(), `${(step / 2).toFixed(1).replace('.', ',')} / 5`);
        }
        await page.keyboard.press('Home');
        await page.keyboard.press('End');
        assert.equal(await page.locator(`#value-${category}`).textContent(), '5,0 / 5');
        const star = row.locator('[data-score="3"]');
        await star.click({position: {x: 8, y: 22}});
        assert.equal(await page.locator(`#value-${category}`).textContent(), '2,5 / 5');
        const painted = await star.locator('.star').boundingBox();
        assert.ok(painted.width >= 29, 'entire half-star silhouette remains visible');
        await star.click({position: {x: 36, y: 22}});
        assert.equal(await page.locator(`#value-${category}`).textContent(), '3,0 / 5');
        await star.focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator(`#value-${category}`).textContent(), '3,0 / 5', 'keyboard click must select a full star');
        const touchStar = await row.locator('[data-score="1"]').boundingBox();
        await page.touchscreen.tap(touchStar.x + 8, touchStar.y + 22);
        assert.equal(await page.locator(`#value-${category}`).textContent(), '0,5 / 5');
        await page.touchscreen.tap(touchStar.x + 36, touchStar.y + 22);
        assert.equal(await page.locator(`#value-${category}`).textContent(), '1,0 / 5');
      }
    } finally { await context.close(); }
  });

  await check('create/start/rate/complete, immutable participant selection, permissions and creator exclusion', async () => {
    const {page, context} = await open();
    try {
      assert.equal(await page.locator('[data-action="start"][data-id="other-waiting"]').count(), 0);
      assert.equal(await page.locator('[data-action="rate"][data-id="not-selected"]').count(), 0);
      assert.equal(await page.locator('[data-action="start"][data-id="running"]').count(), 0);
      await page.click('#openCreate');
      await page.click('#saveCreate');
      assert.match(await page.locator('#createModal .modal-message').textContent(), /Restaurant und Ort/);
      await page.fill('#restaurant', 'Neue lokale Empfehlung');
      await page.fill('#mealPlace', 'Berlin');
      assert.ok(await page.locator('#creatorName').isDisabled());
      assert.equal(await page.locator('#creatorName').inputValue(), longName);
      await page.click('#saveCreate');
      await page.locator('dialog[open]').waitFor({state: 'hidden'});
      const created = await page.evaluate(() => window.__fixture.db.meals.find(meal => meal.restaurant_name === 'Neue lokale Empfehlung'));
      assert.equal(created.status, 'waiting');
      assert.equal(created.creator_member_id, 'm1');
      await page.locator(`[data-action="start"][data-id="${created.id}"]`).click();
      await page.locator('#memberPicker input[value="m2"]').check();
      await page.click('#confirmStart');
      await page.locator(`[data-action="rate"][data-id="${created.id}"]`).waitFor();
      await page.locator(`[data-action="rate"][data-id="${created.id}"]`).click();
      await rateAll(page, 5);
      await page.click('#saveRating');
      await page.locator('dialog[open]').waitFor({state: 'hidden'});
      assert.equal(await page.evaluate(id => window.__fixture.db.meals.find(meal => meal.id === id).status, created.id), 'running');
      assert.equal(await page.locator(`[data-action="rate"][data-id="${created.id}"]`).count(), 0);
      await changeMember(page, 'm3');
      assert.equal(await page.locator(`[data-action="rate"][data-id="${created.id}"]`).count(), 0);
      await changeMember(page, 'm2');
      await page.locator(`[data-action="rate"][data-id="${created.id}"]`).click();
      for (const [index, category] of categories.entries()) {
        const row = page.locator(`[data-rating="${category}"]`);
        await row.locator('[tabindex="0"]').focus();
        await page.keyboard.press('Home');
        for (let i = 0; i < [0, 1, 10, 5][index]; i += 1) await page.keyboard.press('ArrowRight');
      }
      await page.fill('#ratingComment', 'Lokaler Fixture-Kommentar');
      await page.click('#saveRating');
      await page.locator('dialog[open]').waitFor({state: 'hidden'});
      assert.equal(await page.evaluate(id => window.__fixture.db.meals.find(meal => meal.id === id).status, created.id), 'completed');
      await navigate(page, 'history');
      await page.locator(`#history [data-action="details"][data-id="${created.id}"]`).click();
      assert.match(await page.locator('.detail-reviews').textContent(), /Restaurant-Ø \(Essen x3 gewichtet\): 1,3/);
      assert.equal(await page.locator('.creator-badge').count(), 1);
      const submissions = await page.evaluate(() => window.__fixture.calls.filter(call => call.rpc === 'submit_meal_rating'));
      assert.deepEqual(categories.map(key => submissions[1].args[`p_${key}`]), [0, 0.5, 5, 2.5]);
      const selected = await page.evaluate(id => window.__fixture.db.meal_participants.filter(entry => entry.meal_id === id).map(entry => entry.member_id), created.id);
      assert.deepEqual(selected, ['m1', 'm2']);
    } finally { await context.close(); }
  });

  for (const width of [390, 1440]) {
    await check(`submitted reviews become visible after own rating at ${width}px`, async () => {
      const db = data();
      db.meals.find(meal => meal.id === 'running').creator_member_id = 'm1';
      db.meal_participants = db.meal_participants.filter(entry => entry.meal_id !== 'running');
      db.meal_participants.push(...['m1', 'm2', 'm3'].map(member_id => ({meal_id: 'running', member_id})));
      const creatorComment = 'Verborgener Kommentar des Erstellers';
      const participantComment = 'Verborgener Kommentar der Teilnehmerin';
      const finalComment = 'Kommentar der letzten Bewertung';
      db.ratings.push(makeReview('running', 'm1', [5, 5, 5, 5], creatorComment),
        makeReview('running', 'm2', [3, 3, 3, 3], participantComment));
      const {page, context} = await open({width, db, member: 'm3'});
      const details = page.locator('#detailContent');
      const openDetails = () => page.locator('[data-action="details"][data-id="running"]:visible').first().click();
      const reviewsHidden = async () => {
        assert.equal(await details.locator('.history-result-person').count(), 0);
        assert.equal(await details.locator('.history-result-category').count(), 0);
        assert.equal(await details.locator('.rating-summary').count(), 0, 'no interim average');
        const text = await details.textContent();
        for (const other of [creatorComment, participantComment]) {
          assert.equal(text.includes(other), false, 'submitted review comments must remain hidden before own submission');
        }
      };
      const submittedReviewsVisible = async () => {
        assert.equal(await details.locator('.history-result-person').count(), 2);
        assert.equal(await details.locator('.history-result-category').count(), 8);
        assert.equal(await details.locator('.creator-badge').count(), 1);
        assert.equal(await details.locator('.rating-summary').count(), 0, 'interim category averages remain hidden');
        const text = await details.textContent();
        for (const comment of [creatorComment, participantComment]) assert.ok(text.includes(comment));
        assert.match(text, /Restaurant-Durchschnitte erscheinen nach Abschluss/);
      };
      try {
        assert.match(await page.locator('#pendingList').textContent(), /2 von 3 Bewertungen/);
        assert.equal(await page.locator('#dashboardGroupAverage').textContent(), '1,3 ★');
        await openDetails();
        await reviewsHidden();
        assert.match(await details.textContent(), /Bewertungen werden sichtbar, sobald du selbst bewertet hast/);
        await geometry(page, `unfinished reviews ${width}`);
        await screenshot(page, `${width}-reviews-before-own-submission`);
        await changeMember(page, 'm4');
        await reviewsHidden();
        await openDetails();
        assert.match(await details.textContent(), /Du nimmst an dieser Fressung nicht teil/);
        assert.equal(await page.locator('[data-action="rate"][data-id="running"]').count(), 0);
        await changeMember(page, 'm1');
        await openDetails();
        await submittedReviewsVisible();
        assert.equal(await page.evaluate(() => window.__fixture.db.meals.find(meal => meal.id === 'running').status), 'running');
        await screenshot(page, `${width}-reviews-after-own-submission`);
        await navigate(page, 'history');
        assert.equal(await page.locator('#history [data-id="running"]').count(), 0);
        await changeMember(page, 'm2');
        await submittedReviewsVisible();
        await page.goBack();
        await page.locator('#details.active').waitFor();
        await submittedReviewsVisible();
        await changeMember(page, 'm3');
        await reviewsHidden();
        await page.locator('[data-action="rate"][data-id="running"]').click();
        for (const [index, category] of categories.entries()) {
          const row = page.locator(`[data-rating="${category}"]`);
          await row.locator('[tabindex="0"]').focus();
          await page.keyboard.press('Home');
          for (let step = 0; step < [0, 1, 10, 5][index]; step += 1) await page.keyboard.press('ArrowRight');
        }
        await page.fill('#ratingComment', finalComment);
        await page.click('#saveRating');
        await page.locator('#history [data-action="details"][data-id="running"]').waitFor({state: 'attached'});
        assert.equal(await page.evaluate(() => window.__fixture.db.meals.find(meal => meal.id === 'running').status), 'completed');
        await navigate(page, 'history');
        await openDetails();
        assert.equal(await details.locator('.history-result-person').count(), 3);
        assert.equal(await details.locator('.history-result-category').count(), 12);
        assert.equal(await details.locator('.creator-badge').count(), 1);
        for (const comment of [creatorComment, participantComment, finalComment]) {
          assert.ok((await details.textContent()).includes(comment));
        }
        assert.match(await details.textContent(), /Restaurant-Ø \(Essen x3 gewichtet\): 2,2/);
        assert.equal(await details.locator('.rating-summary').count(), 1);
        await geometry(page, `completed reviews ${width}`);
        await screenshot(page, `${width}-reviews-after-completion`);
        await changeMember(page, 'm4');
        await navigate(page, 'history');
        await openDetails();
        assert.equal(await details.locator('.history-result-person').count(), 3, 'completed reviews visible to the group');
      } finally { await context.close(); }
    });
  }

  await check('completed-only statistics, tied ranks, no external score and history/navigation', async () => {
    const {page, context} = await open();
    try {
      assert.equal(await page.locator('#dashboardGroupAverage').textContent(), '1,3 ★');
      assert.equal(await page.locator('#dashboardPersonalRank').textContent(), '#1');
      assert.deepEqual(await page.locator('.rank-num').allTextContents(), ['1', '1', ...Array(10).fill('—')]);
      await navigate(page, 'stats');
      assert.equal(await page.locator('#statsMeals').textContent(), '3');
      assert.equal(await page.locator('#statsRatings').textContent(), '4');
      assert.deepEqual(await page.locator('.stats-category-value').allTextContents(), ['0,0 ★', '0,5 ★', '5,0 ★', '2,5 ★']);
      await navigate(page, 'history');
      assert.equal(await page.locator('.history-card').count(), 3);
      await page.locator('#history [data-action="details"][data-id="solo"]').click();
      assert.match(await page.locator('.detail-reviews').textContent(), /keine Bewertung von einem anderen/);
      await page.goBack();
      await page.locator('#history.active').waitFor();
      await page.goBack();
      await page.locator('#stats.active').waitFor();
    } finally { await context.close(); }
  });

  await check('shared-PIN duplicate auth-event/member load race and gate controls', async () => {
    const {page, context} = await open({member: null, options: {signedOut: true, membersDelay: 200}});
    try {
      await page.fill('#groupPin', 'fixture-only-not-a-real-pin');
      await page.locator('#groupPin').press('Enter');
      await page.locator('#memberScreen:not([hidden])').waitFor();
      assert.equal(await page.locator('#memberSelect option').count(), 12);
      assert.equal(await page.evaluate(() => window.__fixture.calls.filter(call => call.table === 'members').length), 1);
      await page.selectOption('#memberSelect', 'm1');
      await page.click('#chooseMember');
      await page.locator('body.is-authenticated').waitFor();
      await page.locator('.account-menu summary').click();
      await page.locator('[data-account-action="change"]:visible').click();
      await page.click('#cancelMemberChange');
      await page.locator('body.is-authenticated').waitFor();
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY');
    } finally { await context.close(); }
  });

  await check('meal-weighted means rather than participant-weighted means', async () => {
    const db = data();
    db.meals = [makeMeal('a', 'completed'), makeMeal('b', 'completed'), makeMeal('c', 'completed', 'm2')];
    db.ratings = [makeReview('a', 'm2', [5, 5, 5, 5]),
      ...['m2', 'm3', 'm4'].map(id => makeReview('b', id, [1, 1, 1, 1])),
      makeReview('c', 'm1', [4, 4, 4, 4]), makeReview('b', 'm1', [5, 5, 5, 5])];
    const {page, context} = await open({db});
    try {
      assert.equal(await page.locator('#dashboardGroupAverage').textContent(), '3,3 ★');
      assert.match(await page.locator('#dashboardPersonalAverage').textContent(), /Ø 3,0/);
      assert.deepEqual(await page.locator('.rank-num').allTextContents(), ['1', '2', ...Array(10).fill('—')]);
      await navigate(page, 'stats');
      assert.deepEqual(await page.locator('.stats-category-value').allTextContents(), Array(4).fill('2,4 ★'));
    } finally { await context.close(); }
  });

  await check('food has triple weight in combined scores and is labeled x3', async () => {
    const db = data();
    db.meals = [makeMeal('food-favorite', 'completed'), makeMeal('balanced', 'completed', 'm2', 'Balanced'),
      makeMeal('running', 'running', 'm2')];
    db.ratings = [makeReview('food-favorite', 'm2', [5, 1, 1, 1]),
      makeReview('balanced', 'm3', [2, 2, 2, 2])];
    const {page, context} = await open({db});
    try {
      assert.equal(await page.locator('#dashboardGroupAverage').textContent(), '2,5 ★');
      assert.deepEqual((await page.locator('.rank-score').allTextContents()).slice(0, 2), ['3,0 ★', '2,0 ★']);
      await page.locator('[data-action="details"][data-id="food-favorite"]').first().click();
      assert.match(await page.locator('.detail-reviews').textContent(), /Restaurant-Ø \(Essen x3 gewichtet\): 3,0 ★/);
      assert.equal(await page.locator('.history-result-category').first().locator('small').textContent(), 'Essen x3');
      await navigate(page, 'stats');
      assert.equal(await page.locator('.stats-category-label').first().textContent(), 'Essen x3');
      await navigate(page, 'dashboard');
      await page.locator('[data-action="rate"][data-id="running"]').click();
      assert.equal(await page.locator('#label-food').textContent(), 'Essen x3');
    } finally { await context.close(); }
  });

  await check('member creation, duplicate name rejection and auth loading indication', async () => {
    const {page, context} = await open({member: null, options: {signedOut: true, membersDelay: 300}});
    try {
      await page.fill('#groupPin', 'fixture-only');
      await page.click('#loginButton');
      await page.locator('#authMessage.status-message').waitFor();
      assert.equal(await page.locator('#authMessage').getAttribute('role'), 'status');
      await page.locator('#memberScreen:not([hidden])').waitFor();
      await page.fill('#newMemberName', ' BEA ');
      await page.click('#createMember');
      assert.match(await page.locator('#memberMessage').textContent(), /bereits verwendet/);
      await page.fill('#newMemberName', 'Neue Fixture-Person');
      await page.locator('#newMemberName').press('Enter');
      await page.locator('body.is-authenticated').waitFor();
      assert.match(await page.locator('#dashboardTitle').textContent(), /Neue/);
      const insert = await page.evaluate(() => window.__fixture.calls.find(call => call.table === 'members' && call.operation === 'insert'));
      assert.deepEqual(insert.value, {display_name: 'Neue Fixture-Person', is_active: true});
    } finally { await context.close(); }
    const empty = data();
    empty.members = []; empty.meals = []; empty.meal_participants = []; empty.ratings = [];
    const first = await open({member: null, db: empty});
    try {
      assert.ok(await first.page.locator('#memberChoiceWrap').isHidden());
      await first.page.fill('#newMemberName', 'Erste Fixture-Person');
      await first.page.click('#createMember');
      await first.page.locator('body.is-authenticated').waitFor();
      assert.equal(await first.page.locator('#pendingCount').textContent(), '0');
    } finally { await first.context.close(); }
  });

  await check('desktop account cancellation returns focus and icon boxes are centered', async () => {
    const {page, context} = await open({width: 1440});
    try {
      await page.locator('.sidebar [data-account-action="change"]').click();
      await page.click('#cancelMemberChange');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.accountAction), 'change');
      await page.click('#openCreate');
      const iconErrors = await page.evaluate(() => [...document.querySelectorAll('dialog[open] button .icon')].filter(icon => {
        const button = icon.closest('button');
        const a = button.getBoundingClientRect();
        const b = icon.getBoundingClientRect();
        if (button.classList.contains('close')) return Math.abs(a.x + a.width / 2 - b.x - b.width / 2) > 1;
        return Math.abs(a.y + a.height / 2 - b.y - b.height / 2) > 1;
      }).length);
      assert.equal(iconErrors, 0);
    } finally { await context.close(); }
  });

  await check('empty start selection and persistent start/rating failure without false success', async () => {
    const {page, context} = await open();
    try {
      await page.locator('[data-action="start"][data-id="waiting"]').click();
      await page.locator('#memberPicker input[value="m1"]').uncheck();
      await page.click('#confirmStart');
      assert.match(await page.locator('#startModal .modal-message').textContent(), /mindestens eine/);
      await page.locator('#memberPicker input[value="m1"]').check();
      await page.evaluate(() => { window.__fixture.errors.start_meal = 'Start fixture offline'; });
      await page.click('#confirmStart');
      await page.locator('#confirmStart:not([disabled])').waitFor();
      assert.match(await page.locator('#startModal .modal-message').textContent(), /Start fixture offline/);
      await closeDialog(page);
      await page.locator('[data-action="rate"][data-id="running"]').click();
      await page.click('#saveRating');
      assert.match(await page.locator('#ratingModal .modal-message').textContent(), /alle vier/);
      await rateAll(page, 0.5);
      await page.evaluate(() => { window.__fixture.errors.submit_meal_rating = 'Rating fixture offline'; });
      await page.click('#saveRating');
      await page.locator('#saveRating:not([disabled])').waitFor();
      assert.match(await page.locator('#ratingModal .modal-message').textContent(), /Rating fixture offline/);
      assert.equal(await page.evaluate(() => window.__fixture.db.ratings.filter(review => review.meal_id === 'running').length), 0);
    } finally { await context.close(); }
  });

  await check('persistent login, data and save errors; empty/loading states', async () => {
    const login = await open({options: {signedOut: true, loginError: true}});
    try {
      await login.page.fill('#groupPin', 'fixture-only');
      await login.page.click('#loginButton');
      await login.page.locator('#authMessage:not([hidden])').waitFor();
      assert.match(await login.page.locator('#authMessage').textContent(), /nicht korrekt/);
    } finally { await login.context.close(); }
    const empty = data();
    empty.meals = []; empty.ratings = []; empty.meal_participants = [];
    const {page, context} = await open({db: empty});
    try {
      assert.match(await page.locator('#pendingList').textContent(), /Keine offenen/);
      await page.click('#openCreate');
      await page.fill('#restaurant', 'Fehler-Fixture');
      await page.fill('#mealPlace', 'Berlin');
      await page.evaluate(() => { window.__fixture.errors.meals = 'Fixture offline'; });
      await page.click('#saveCreate');
      await page.locator('.modal-message:not([hidden])').waitFor();
      assert.match(await page.locator('#createModal .modal-message').textContent(), /Fixture offline/);
      await page.waitForTimeout(4000);
      assert.ok(await page.locator('#createModal .modal-message').isVisible());
      assert.ok(await page.locator('#saveCreate').isEnabled());
      await screenshot(page, '390-create-persistent-error');
      await closeDialog(page);
      await page.locator('.account-menu summary').click();
      await page.locator('[data-account-action="change"]:visible').click();
      await page.click('#chooseMember');
      await page.locator('#memberMessage:not([hidden])').waitFor();
      assert.match(await page.locator('#memberMessage').textContent(), /Fixture offline/);
    } finally { await context.close(); }
  });

  await check('Restaurant finder uses OSM with live Photon suggestions and manual Nominatim search', async () => {
    const {page, context, searches, photonRequests} = await open();
    try {
      await page.click('#openCreate');
      assert.equal(await page.locator('#osmMapFrame').isVisible(), true);
      assert.equal(await page.locator('[data-map-provider]').count(), 0);
      await page.fill('#restaurantSearchQuery', 'Lokale Suche');
      await page.waitForTimeout(100);
      assert.equal(searches.length, 0);
      assert.equal(photonRequests.length, 0);
      await page.locator('.photon-result').first().waitFor();
      assert.equal(searches.length, 0);
      assert.equal(photonRequests.length, 1);
      assert.equal(new URL(photonRequests[0].url).searchParams.get('q'), 'Lokale Suche');
      assert.equal(new URL(photonRequests[0].url).searchParams.getAll('osm_tag').length, 6);
      assert.equal(await page.locator('.photon-result').count(), 2);
      await page.locator('.photon-result').first().click();
      assert.equal(await page.locator('#restaurant').inputValue(), 'Photon Restaurant 1');
      assert.equal(await page.locator('#mealPlace').inputValue(), 'Photon Straße 1, 10115 Berlin, Deutschland');
      assert.match(await page.locator('#mapsUrl').inputValue(), /openstreetmap\.org/);
      assert.equal(new URL(await page.locator('#osmMapFrame').getAttribute('src')).searchParams.get('marker'), '52.500000,13.400000');
      await page.fill('#restaurant', 'Manuell bearbeitet');
      assert.equal(await page.locator('#restaurant').inputValue(), 'Manuell bearbeitet');
      await page.fill('#restaurantSearchQuery', '  LOKALE   SUCHE  ');
      await page.click('#restaurantSearchButton');
      await page.locator('.osm-result').first().waitFor();
      assert.equal(searches.length, 1);
      assert.equal(await page.locator('.photon-result').count(), 0);
      assert.equal(new URL(searches[0].url).searchParams.get('limit'), '5');
      await page.fill('#restaurantSearchQuery', 'Zweite lokale Suche');
      await page.click('#restaurantSearchButton');
      await page.locator('.osm-result').first().waitFor();
      assert.equal(searches.length, 2);
      assert.ok(searches[1].at - searches[0].at >= 950);
      const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('connoisseure.nominatim-search-cache')));
      assert.equal(cache.length, 2);
      assert.ok(cache[0][1].expiresAt - Date.now() > 23 * 60 * 60 * 1000);
      await screenshot(page, '390-create-osm-results');
    } finally { await context.close(); }
  });

  await check('OSM cache expiration/max20 and 60s cooldown for 429/503', async () => {
    const key = 'connoisseure.nominatim-search-cache';
    const cache = Array.from({length: 21}, (_, index) => [`query ${index}`, {results: [], expiresAt: Date.now() + 86400000}]);
    cache.push(['expired query', {results: [{display_name: 'Expired'}], expiresAt: Date.now() - 1}]);
    const first = await open({storage: {[key]: JSON.stringify(cache)}});
    try {
      await first.page.click('#openCreate');
      await first.page.fill('#restaurantSearchQuery', 'Expired query');
      await first.page.click('#restaurantSearchButton');
      await first.page.locator('.osm-result').first().waitFor();
      assert.equal(first.searches.length, 1);
      assert.equal(await first.page.evaluate(key => JSON.parse(localStorage.getItem(key)).length, key), 20);
    } finally { await first.context.close(); }
    for (const status of [429, 503]) {
      const {page, context, searches} = await open();
      try {
        await page.click('#openCreate');
        await page.fill('#restaurantSearchQuery', `Fixture ${status}`);
        await page.click('#restaurantSearchButton');
        await page.locator('#restaurantSearchButton:not([disabled])').waitFor();
        assert.match(await page.locator('#restaurantSearchStatus').textContent(), /mindestens eine Minute/);
        const until = await page.evaluate(() => Number(localStorage.getItem('connoisseure.nominatim-cooldown-until')));
        assert.ok(until - Date.now() > 59000);
        await page.fill('#restaurantSearchQuery', 'Weitere Anfrage');
        await page.click('#restaurantSearchButton');
        assert.equal(searches.length, 1);
        assert.match(await page.locator('#restaurantSearchStatus').textContent(), /warte eine Minute/);
      } finally { await context.close(); }
    }
  });

  await check('HTML selectors, unique IDs, labels and Pages relative assets', async () => {
    const {page, context} = await open();
    try {
      const errors = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
        const badLabels = [...document.querySelectorAll('label[for]')].filter(label => !document.getElementById(label.htmlFor)).length;
        const badIcons = [...document.querySelectorAll('use')].filter(use => !document.querySelector(use.getAttribute('href'))).length;
        return {duplicates, badLabels, badIcons};
      });
      assert.deepEqual(errors, {duplicates: [], badLabels: 0, badIcons: 0});
      const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
      assert.ok(html.includes('href="./styles.css"') && html.includes('src="./app.js"'));
      assert.ok(!html.includes('<style>') && !html.includes('style='));
      const css = await fs.readFile(path.join(root, 'styles.css'), 'utf8');
      assert.ok(css.includes('url("./chevron.svg")'));
      assert.ok((await fs.readFile(path.join(root, 'chevron.svg'), 'utf8')).startsWith('<svg'));
      const contrast = await page.evaluate(() => {
        const css = getComputedStyle(document.documentElement);
        const luminance = token => {
          const rgb = css.getPropertyValue(token).trim().slice(1).match(/../g)
            .map(value => parseInt(value, 16) / 255)
            .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        return ['--ink', '--muted', '--gold', '--warning', '--error', '--sage-dark']
          .map(token => (luminance('--card') + 0.05) / (luminance(token) + 0.05));
      });
      assert.ok(contrast.every(ratio => ratio >= 4.5), 'text tokens must contrast with card surfaces');
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
})().catch(error => {
  failures.push({name: 'Harness', error: error.stack});
  console.error(error.stack);
}).finally(async () => {
  const browserVersion = browser?.version();
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(screenshots, 'report.json'), JSON.stringify({
    browser: process.env.BROWSER_ENGINE || process.env.BROWSER_CHANNEL || 'msedge',
    browserVersion, checks, fixtureSessions, screenshotCount, failures, pageErrors, widths
  }, null, 2));
  console.log(`${checks} checks passed; ${failures.length} failed. Screenshots: ${screenshots}`);
  process.exitCode = failures.length ? 1 : 0;
});
