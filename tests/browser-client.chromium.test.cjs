const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Real Chromium, synthetic HTML only: no Medium requests or account state.
const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(root, '.chromium-fixture-'));
process.chdir(fixture);
process.env.MEDIUM_HEADLESS = 'true';
process.env.MEDIUM_MAX_CONTENT_LENGTH = '50000';
const { BrowserMediumClient } = require('../dist/browser-client.js');
const launch = chromium.launch.bind(chromium);
after(() => {
  chromium.launch = launch;
  process.chdir(root);
  fs.rmSync(fixture, { recursive: true, force: true });
});

const destination = 'https://medium.com/@fixture/story-abcdef123456';
const redirect = url => '/m/signin?redirect=' + encodeURIComponent(url);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const paragraph = 'Controlled local test article, with no remote Medium content or account data.';
const article = '<article><h1>Local fixture</h1>' + `<p>${paragraph}</p>`.repeat(4) + '</article>';

async function setup(t, respond, { failFirstPage = false } = {}) {
  const browsers = [];
  const contexts = [];
  const requests = [];
  let injected = false;
  chromium.launch = async options => {
    const browser = await launch(options);
    browsers.push(browser);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      contexts.push(context);
      await context.route('**/*', async route => {
        requests.push(route.request().url());
        await respond(route);
      });
      if (failFirstPage && !injected) {
        injected = true;
        context.newPage = async () => { throw Error('controlled initialization failure'); };
      }
      return context;
    };
    return browser;
  };
  const client = new BrowserMediumClient();
  t.after(async () => {
    try { await client.close(); }
    finally {
      await Promise.all(browsers.map(browser => browser.close()));
      chromium.launch = launch;
    }
  });
  return { client, browsers, contexts, requests };
}

const html = (route, body) => route.fulfill({ contentType: 'text/html', body });

test('real Chromium decodes redirects, rejects invalid destinations and uses search fallbacks', async t => {
  const cards = [];
  const expected = [];
  function add(title, markup, accepted = true) {
    cards.push(`<article>${markup(title)}</article>`);
    if (accepted) expected.push({ title, url: destination });
  }
  const link = escape(redirect(destination + '?source=fixture#fragment'));
  add('Title redirect', title => `<a href="${link}"><h2>${title}</h2></a>`);
  add('Heading redirect', title => `<h1>${title}</h1><a href="${link}"><h2>Link</h2></a>`);
  add('Slug redirect', title => `<h2>${title}</h2><a href="${link}">Read</a>`);
  add('Data redirect', title => `<h2>${title}</h2><div data-href="${link}"></div>`);
  const invalid = [
    '/m/signin', '/m/signup?source=fixture',
    redirect('https://example.invalid/story-abcdef123456'),
    redirect('https://medium.com.example.invalid/story-abcdef123456'),
    redirect('http://medium.com/story-abcdef123456'),
    redirect('https://fixture:dummy@medium.com/story-abcdef123456'),
    redirect('https://medium.com:444/story-abcdef123456'),
    redirect('javascript:void(0)'),
    redirect('https://medium.com' + redirect(destination)),
    '/m/signin?redirect=https%3A%2F%2F%5B',
    'https://example.invalid' + redirect(destination),
  ];
  invalid.forEach((url, index) => {
    const heading = title => `<a href="${escape(url)}"><h2>${title}</h2></a>`;
    add(`Rejected ${index}`, heading, false);
    add(`Fallback ${index}`, title => heading(title) + `<a href="${destination}">Read</a>`);
  });
  const state = await setup(t, route => html(route, cards.join('')));
  await state.client.initialize();
  const results = await state.client.searchMediumArticles(['controlled fixture']);
  assert.deepEqual(results.map(({ title, url }) => ({ title, url })), expected);
  assert(results.every(result => result.claps === null));
  assert.deepEqual(state.requests, ['https://medium.com/search?q=controlled%20fixture']);
});

test('real Chromium closes partial initialization and shares concurrent retries', async t => {
  const state = await setup(t, route => html(route, article), { failFirstPage: true });
  const outcomes = await Promise.allSettled([state.client.initialize(), state.client.initialize()]);
  assert(outcomes.every(result => result.status === 'rejected' && /controlled initialization failure/.test(result.reason.message)));
  assert.equal(state.browsers.length, 1);
  assert.equal(state.browsers[0].isConnected(), false);
  assert.equal(state.browsers[0].contexts().length, 0);
  await Promise.all([state.client.initialize(), state.client.initialize()]);
  assert.equal(state.browsers.length, 2);
  assert.equal(state.contexts[1].pages().length, 1);
  assert.equal(await state.client.getArticleContent(destination, false), Array(4).fill(paragraph).join('\n\n'));
  await state.client.close();
  assert(state.browsers.every(browser => !browser.isConnected()));
});

test('real Chromium closes article tabs after navigation and DOM extraction failures', async t => {
  let mode = 'navigation';
  const state = await setup(t, route => {
    if (mode === 'navigation') return route.abort('failed');
    const failure = `<script>for (const p of document.querySelectorAll('article p')) {
      Object.defineProperty(p, 'textContent', { get() { throw Error('controlled DOM extraction failure'); } });
    }</script>`;
    return html(route, article + (mode === 'extraction' ? failure : ''));
  });
  await state.client.initialize();
  const context = state.contexts[0];
  const originalPage = context.pages()[0];
  for (const failure of ['navigation', 'extraction']) {
    mode = failure;
    await assert.rejects(state.client.getArticleContent(destination, false),
      failure === 'navigation' ? /net::ERR_FAILED/ : /controlled DOM extraction failure/);
    assert.deepEqual(context.pages(), [originalPage]);
  }
  mode = 'success';
  assert.equal(await state.client.getArticleContent(destination, false), Array(4).fill(paragraph).join('\n\n'));
  assert.deepEqual(context.pages(), [originalPage]);
});

test('real headless Chromium reads controlled public content after default login attempt fails', async t => {
  const state = await setup(t, route => html(route,
    route.request().url() === destination ? article : '<main>Anonymous local fixture</main>'));
  await state.client.initialize();
  const content = await state.client.getArticleContent(destination);
  assert.equal(content, Array(4).fill(paragraph).join('\n\n'));
  assert.deepEqual(state.requests, ['https://medium.com/', destination]);
  assert.equal(state.contexts[0].pages().length, 1);
  assert.equal(fs.existsSync('medium-session.json'), false);
});
