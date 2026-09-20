const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(root, '.browser-review-'));
fs.writeFileSync(path.join(fixture, '.env'), `MEDIUM_HEADLESS=false\nMEDIUM_MAX_CONTENT_LENGTH=100\nMEDIUM_SESSION_DIR=${fixture}\n`);
for (const key of ['MEDIUM_HEADLESS', 'MEDIUM_MAX_CONTENT_LENGTH', 'MEDIUM_SESSION_DIR']) delete process.env[key];
process.chdir(fixture);
const { BrowserMediumClient } = require('../dist/browser-client.js');
process.chdir(root);
const { chromium } = require('playwright');
const originalLaunch = chromium.launch;
after(() => { chromium.launch = originalLaunch; fs.rmSync(fixture, { recursive: true, force: true }); });

function harness({ fail, document } = {}) {
  const state = { launches: 0, closes: 0, tabsClosed: 0, visits: [], authenticated: false };
  const page = {
    async goto(url) { state.visits.push(url); if (fail === 'navigation' && url.includes('/@')) throw Error('navigation'); },
    async waitForTimeout() {},
    async waitForSelector(selector, options) {
      if (selector === 'article') return;
      assert(!selector.includes('.avatar'));
      if (!state.authenticated && !(state.loginSucceeds && options.timeout === 300000)) throw Error('anonymous');
    },
    async evaluate(fn, arg) {
      if (fail === 'extraction') throw Error('extraction');
      return vm.runInNewContext(`(${fn.toString()})(arg)`, { document, arg, window: { scrollBy() {}, innerHeight: 900 } });
    },
    async close() { state.tabsClosed++; },
    url() { return 'https://medium.com/search'; }
  };
  const context = {
    async addInitScript() { if (fail === 'context') throw Error('context'); },
    async newPage() { return page; },
    async storageState() { return { cookies: [], origins: [] }; }
  };
  chromium.launch = async options => {
    state.launches++;
    state.launchOptions = options;
    return {
      async newContext(options) { state.contextOptions = options; return context; },
      async close() { state.closes++; }
    };
  };
  return state;
}

 test('concurrent initialization shares resources and reads dotenv before launch', async () => {
  const state = harness();
  const client = new BrowserMediumClient();
  await Promise.all([client.initialize(), client.initialize()]);
  assert.equal(state.launches, 1);
  assert.equal(state.launchOptions.headless, false);
  assert(!state.launchOptions.args.some(arg => arg.startsWith('--user-agent=')));
  assert.equal(typeof state.contextOptions.userAgent, 'string');
  await client.close();
  assert.equal(state.closes, 1);
});

test('partial initialization closes browser and permits retry', async () => {
  const failed = harness({ fail: 'context' });
  const client = new BrowserMediumClient();
  const results = await Promise.allSettled([client.initialize(), client.initialize()]);
  assert(results.every(result => result.status === 'rejected'));
  assert.equal(failed.launches, 1);
  assert.equal(failed.closes, 1);
  const recovered = harness();
  await client.initialize();
  await client.close();
  assert.equal(recovered.closes, 1);
});

test('close waits for an initialization in progress', async () => {
  const state = harness();
  const client = new BrowserMediumClient();
  await Promise.all([client.initialize(), client.close()]);
  assert.equal(state.closes, 1);
});

for (const session of ['{broken', JSON.stringify({ cookies: [], origins: [] })]) {
  test(`unverified session cannot claim login; reconnection is observed (${session})`, async () => {
    fs.writeFileSync(path.join(fixture, 'medium-session.json'), session);
    const state = harness();
    const client = new BrowserMediumClient();
    await client.initialize();
    assert.equal(await client.ensureLoggedIn(), false);
    assert(state.visits.includes('https://medium.com/m/signin'));
    state.loginSucceeds = true;
    assert.equal(await client.ensureLoggedIn(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture, 'medium-session.json'))), { cookies: [], origins: [] });
    await client.close();
  });
}

for (const fail of ['navigation', 'extraction']) {
  test(`article tab closes on ${fail} failure without requiring login`, async () => {
    const state = harness({ fail });
    const client = new BrowserMediumClient();
    await client.initialize();
    await assert.rejects(client.getArticleContent('https://medium.com/@author/story', false));
    assert.equal(state.tabsClosed, 1);
    assert.deepEqual(state.visits, ['https://medium.com/@author/story']);
    await client.close();
  });
}

for (const mode of ['paragraphs', 'fallback']) {
  test(`${mode} extraction applies and announces the same length limit`, async () => {
    const paragraphs = Array.from({ length: 4 }, () => ({ textContent: 'a'.repeat(80) }));
    const document = {
      title: 'Article', body: { textContent: 'Public story', innerText: 'Public story' },
      querySelectorAll() { return mode === 'paragraphs' ? paragraphs : []; },
      querySelector(selector) { return selector === 'article' ? { textContent: 'b'.repeat(350) } : null; }
    };
    const state = harness({ document });
    const client = new BrowserMediumClient();
    await client.initialize();
    const content = await client.getArticleContent('https://medium.com/@author/story', false);
    assert.equal(content.split('\n\n[TRUNCATED:')[0].length, 100);
    assert.match(content, /TRUNCATED: 100 of \d+ characters/);
    assert.equal(state.tabsClosed, 1);
    await client.close();
  });
}

test('anonymous search preserves article URL and reports unobserved claps as null', async () => {
  const title = { textContent: 'Public story', closest: () => ({ href: 'https://medium.com/@author/story-abcdef123456?source=search' }) };
  const article = {
    querySelector: selector => selector === 'h2' ? title : null,
    querySelectorAll: selector => selector === 'span' ? [{ textContent: '42' }] : []
  };
  const document = { querySelectorAll: selector => selector === 'article' ? [article] : [] };
  const state = harness({ document });
  const client = new BrowserMediumClient();
  await client.initialize();
  const articles = await client.searchMediumArticles(['public']);
  assert.equal(articles.length, 1);
  assert.equal(articles[0].claps, null);
  assert.equal(articles[0].url, 'https://medium.com/@author/story-abcdef123456');
  assert.deepEqual(state.visits, ['https://medium.com/search?q=public']);
  await client.close();
});

test('headless mode from dotenv reaches launch and refuses unobserved login', () => {
  const { spawnSync } = require('node:child_process');
  fs.writeFileSync(path.join(fixture, '.env'), `MEDIUM_HEADLESS=true\nMEDIUM_SESSION_DIR=${fixture}\n`);
  const program = `
    const assert = require('node:assert/strict');
    const { BrowserMediumClient } = require(${JSON.stringify(path.join(root, 'dist/browser-client.js'))});
    const { chromium } = require(${JSON.stringify(path.join(root, 'node_modules/playwright'))});
    chromium.launch = async options => {
      assert.equal(options.headless, true);
      return {
        async newContext() { return {
          async addInitScript() {},
          async newPage() { return {
            async goto(url) { assert.equal(url, 'https://medium.com'); },
            async waitForTimeout() {},
            async waitForSelector() { throw Error('anonymous'); }
          }; }
        }; },
        async close() {}
      };
    };
    (async () => {
      const client = new BrowserMediumClient();
      await client.initialize();
      assert.equal(await client.ensureLoggedIn(), false);
      await client.close();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const env = { ...process.env };
  delete env.MEDIUM_HEADLESS;
  const result = spawnSync(process.execPath, ['-e', program], { cwd: fixture, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
