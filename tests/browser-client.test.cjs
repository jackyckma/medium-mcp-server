const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.cwd();
const fixture = fs.mkdtempSync(path.join(root, '.browser-review-'));
fs.writeFileSync(path.join(fixture, '.env'), `MEDIUM_HEADLESS=false\nMEDIUM_MAX_CONTENT_LENGTH=100\n`);
for (const key of ['MEDIUM_HEADLESS', 'MEDIUM_MAX_CONTENT_LENGTH', 'MEDIUM_SESSION_DIR']) delete process.env[key];
process.chdir(fixture);
const { BrowserMediumClient } = require('../dist/browser-client.js');
const { chromium } = require('playwright');
const originalLaunch = chromium.launch;
after(() => { process.chdir(root); chromium.launch = originalLaunch; fs.rmSync(fixture, { recursive: true, force: true }); });

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
    assert.equal(fs.statSync(path.join(fixture, 'medium-session.json')).mode & 0o777, 0o600);
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

test('headless mode observes failed login and still reads public articles by default', () => {
  const { spawnSync } = require('node:child_process');
  fs.writeFileSync(path.join(fixture, '.env'), `MEDIUM_HEADLESS=true\n`);
  const program = `
    const assert = require('node:assert/strict');
    const { BrowserMediumClient } = require(${JSON.stringify(path.join(root, 'dist/browser-client.js'))});
    const { chromium } = require(${JSON.stringify(path.join(root, 'node_modules/playwright'))});
    const visits = [];
    let evaluations = 0;
    chromium.launch = async options => {
      assert.equal(options.headless, true);
      return {
        async newContext() { return {
          async addInitScript() {},
          async newPage() { return {
            async goto(url) { visits.push(url); },
            async waitForTimeout() {},
            async waitForSelector() { throw Error('anonymous'); },
            async evaluate() { return ++evaluations === 1 ? { hasArticle: true } : 'Public article'; },
            async close() {}
          }; }
        }; },
        async close() {}
      };
    };
    (async () => {
      const client = new BrowserMediumClient();
      await client.initialize();
      assert.equal(await client.ensureLoggedIn(), false);
      assert.equal(await client.getArticleContent('https://medium.com/@author/public'), 'Public article');
      assert.deepEqual(visits, ['https://medium.com', 'https://medium.com', 'https://medium.com/@author/public']);
      await client.close();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const env = { ...process.env };
  delete env.MEDIUM_HEADLESS;
  const result = spawnSync(process.execPath, ['-e', program], { cwd: fixture, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('existing local session is loaded and unrelated directories are ignored', async () => {
  const other = path.join(fixture, 'other');
  fs.mkdirSync(other);
  const unrelated = { cookies: [], origins: [{ origin: 'https://medium.com', localStorage: [{ name: 'fixture', value: 'unrelated' }] }] };
  const local = { cookies: [], origins: [] };
  fs.writeFileSync(path.join(other, 'medium-session.json'), JSON.stringify(unrelated));
  fs.writeFileSync(path.join(fixture, 'medium-session.json'), JSON.stringify(local));
  process.env.MEDIUM_SESSION_DIR = other;
  const state = harness();
  const client = new BrowserMediumClient();
  await client.initialize();
  assert.deepEqual(state.contextOptions.storageState, local);
  await client.saveSession();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other, 'medium-session.json'))), unrelated);
  assert.equal(fs.statSync(path.join(fixture, 'medium-session.json')).mode & 0o777, 0o600);
  await client.close();
  delete process.env.MEDIUM_SESSION_DIR;
});

test('login navigation failure does not prevent public article extraction', async () => {
  const paragraphs = Array.from({ length: 4 }, () => ({ textContent: 'public content '.repeat(3) }));
  const document = {
    title: 'Article', body: { textContent: 'Public story', innerText: 'Public story' },
    querySelectorAll() { return paragraphs; }, querySelector() { return null; }
  };
  const state = harness({ document });
  const client = new BrowserMediumClient();
  await client.initialize();
  client.ensureLoggedIn = async () => { throw Error('login unavailable'); };
  assert.match(await client.getArticleContent('https://medium.com/@author/story'), /^public content/);
  assert.deepEqual(state.visits, ['https://medium.com/@author/story']);
  await client.close();
});

test('navigation stays restricted to Medium HTTPS hosts regardless of environment', async () => {
  const { spawnSync } = require('node:child_process');
  const program = `
    const assert = require('node:assert/strict');
    const { BrowserMediumClient } = require(${JSON.stringify(path.join(root, 'dist/browser-client.js'))});
    const { chromium } = require(${JSON.stringify(path.join(root, 'node_modules/playwright'))});
    const visits = [];
    chromium.launch = async () => ({
      async newContext() { return {
        async addInitScript() {},
        async newPage() { return {
          async goto(url) { visits.push(url); },
          async waitForTimeout() {},
          async evaluate() { return { hasArticle: true, length: 0 }; },
          async close() {}
        }; }
      }; },
      async close() {}
    });
    (async () => {
      const client = new BrowserMediumClient();
      await client.initialize();
      for (const url of ['https://example.net/story', 'https://medium.com.example.net/story', 'https://notmedium.com/story', 'http://medium.com/story', 'file://medium.com/story']) {
        await assert.rejects(client.getArticleContent(url, false), /Refusing to navigate/);
      }
      assert.deepEqual(visits, []);
      for (const url of ['https://medium.com/story', 'https://publication.medium.com/story']) await client.getArticleContent(url, false);
      assert.equal(visits.length, 2);
      await client.close();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', program], {
    cwd: fixture, env: { ...process.env, MEDIUM_ALLOWED_HOSTS: 'example.net' }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
});
