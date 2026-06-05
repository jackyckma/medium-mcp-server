import { chromium, BrowserContext, Page } from 'playwright';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';

export interface MediumArticle {
  title: string;
  content: string;
  url?: string;
  publishDate?: string;
  tags?: string[];
  claps?: number;
}

export interface PublishOptions {
  title: string;
  content: string;
  tags?: string[];
  isDraft?: boolean;
}

// IMPORTANT: this UA must stay CONSISTENT between the visible login window and
// the headless background runs. Cloudflare ties its `cf_clearance` cookie to the
// exact User-Agent; if the headed login and the headless work use different UAs
// (e.g. real "Chrome" vs "HeadlessChrome"), the clearance is rejected and every
// headless navigation gets stuck on the "Just a moment…" bot challenge.
// It should also roughly match the bundled Chromium major version.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

const LAUNCH_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
];

/**
 * Browser-based Medium client backed by a PERSISTENT Chrome profile.
 *
 * Design notes (the hard-won bits):
 *  - A persistent user-data dir keeps cookies WITH an expiry across restarts, but
 *    Chromium drops pure *session* cookies (Medium's `sid`/`xsrf`) when a context
 *    is closed and reopened. So we ALSO snapshot the full storage state to
 *    `sessionFile` and re-inject it on every launch — this is what carries the
 *    login through the headed→headless switch and across server restarts.
 *  - Cloudflare guards the logged-in pages. We pass it by (a) keeping the UA
 *    identical between headed login and headless work, and (b) waiting out the
 *    "Just a moment…" interstitial after each navigation.
 *  - "Logged in" is verified from the actual page (absence of the header Sign-in
 *    button), not just cookie presence — Medium sets `sid`/`uid` for anonymous
 *    visitors too, so cookie presence alone is not proof of authentication.
 */
export class BrowserMediumClient {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private currentHeadless: boolean | null = null;

  // Stable locations, independent of where the MCP server is launched from.
  private userDataDir = join(homedir(), '.medium-mcp-chrome');
  private sessionFile = join(homedir(), '.medium-mcp-session.json');

  private readonly PUBLISHED_URL = 'https://medium.com/me/stories?tab=posts-published';

  /** Kept for API compatibility. Browser launches lazily on first use. */
  async initialize(): Promise<void> {}

  // ---------------------------------------------------------------------------
  // Browser lifecycle
  // ---------------------------------------------------------------------------

  private async ensureBrowser(headless: boolean): Promise<void> {
    if (this.context && this.currentHeadless === headless && this.page && !this.page.isClosed()) {
      return;
    }

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }

    mkdirSync(this.userDataDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      headless,
      viewport: { width: 1280, height: 800 },
      userAgent: USER_AGENT,
      args: LAUNCH_ARGS,
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.currentHeadless = headless;

    // Re-inject saved cookies (incl. session cookies the on-disk profile drops),
    // unless the fresh context already carries an authenticated cookie.
    if (!(await this.hasAuthCookie())) {
      await this.seedFromSessionFile();
    }
  }

  /** Heuristic: `xsrf` is set by Medium only for an authenticated session. */
  private async hasAuthCookie(): Promise<boolean> {
    if (!this.context) return false;
    const cookies = await this.context.cookies('https://medium.com');
    return cookies.some(c => c.name === 'xsrf');
  }

  private async seedFromSessionFile(): Promise<void> {
    if (!this.context || !existsSync(this.sessionFile)) return;
    try {
      const state = JSON.parse(readFileSync(this.sessionFile, 'utf8'));
      if (Array.isArray(state.cookies) && state.cookies.length > 0) {
        await this.context.addCookies(state.cookies);
      }
    } catch (error) {
      console.error('Failed to restore session cookies:', error);
    }
  }

  private async persistState(): Promise<void> {
    if (!this.context) return;
    try {
      const state = await this.context.storageState();
      writeFileSync(this.sessionFile, JSON.stringify(state));
    } catch (error) {
      console.error('Failed to persist session state:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Cloudflare + auth helpers
  // ---------------------------------------------------------------------------

  /** Wait out the Cloudflare "Just a moment…" interstitial after a navigation. */
  private async waitForChallenge(timeoutMs = 45000): Promise<void> {
    if (!this.page) return;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const title = (await this.page.title().catch(() => '')) || '';
      const isChallenge =
        /just a moment|bir dakika|lütfen|moment|checking|security verif|doğrulama|verify you/i.test(title);
      if (!isChallenge) break;
      await this.page.waitForTimeout(1500);
    }
    // Small settle delay for the SPA to hydrate after the challenge clears.
    await this.page.waitForTimeout(1500);
  }

  /** Is the currently loaded page authenticated? (No header Sign-in button.) */
  private async isPageLoggedIn(): Promise<boolean> {
    if (!this.page) return false;
    return await this.page
      .evaluate(() => !document.querySelector('[data-testid="headerSignInButton"]') &&
        !!document.querySelector('[data-testid="headerUserIcon"], [data-testid="headerWriteButton"]'))
      .catch(() => false);
  }

  /**
   * Ensure we have an authenticated session. Returns instantly if already logged
   * in (headless/background). Otherwise opens ONE visible window for sign-in,
   * then drops back to headless. The login is reused silently afterwards.
   */
  async ensureLoggedIn(): Promise<boolean> {
    // Fast path: verify auth in the headless background context.
    await this.ensureBrowser(true);
    if (await this.verifyLoggedIn()) return true;

    // Need the user: relaunch the SAME profile with a visible window.
    console.error('🔐 No valid session — opening a one-time login window...');
    await this.ensureBrowser(false);
    if (!this.page) throw new Error('Browser not initialized');

    await this.page.goto('https://medium.com/m/signin', { waitUntil: 'domcontentloaded' });
    console.error('🔐 Complete sign-in (and any 2FA) in the opened window. This is a ONE-TIME step.');

    // Poll until Medium issues the authenticated `xsrf` cookie.
    const start = Date.now();
    let authed = false;
    while (Date.now() - start < 300000) {
      if (await this.hasAuthCookie()) { authed = true; break; }
      await this.page.waitForTimeout(1500);
    }

    if (!authed) {
      console.error('❌ Login timed out after 5 minutes.');
      return false;
    }

    // Snapshot the full session NOW (captures session cookies + cf_clearance),
    // then return to a headless background context that re-seeds from it.
    await this.persistState();
    console.error('✅ Login captured. Switching to headless background mode...');
    await this.ensureBrowser(true);
    return await this.verifyLoggedIn();
  }

  /** Navigate to the homepage, clear Cloudflare, and confirm authentication. */
  private async verifyLoggedIn(): Promise<boolean> {
    if (!this.page) return false;
    await this.page.goto('https://medium.com', { waitUntil: 'domcontentloaded' });
    await this.waitForChallenge();
    const ok = await this.isPageLoggedIn();
    if (ok) await this.persistState();
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  /** Retrieve the signed-in user's own published stories. */
  async getUserArticles(): Promise<MediumArticle[]> {
    if (!(await this.ensureLoggedIn())) {
      throw new Error('Medium login was not completed (timed out or cancelled).');
    }
    if (!this.page) throw new Error('Browser not initialized');

    await this.page.goto(this.PUBLISHED_URL, { waitUntil: 'domcontentloaded' });
    await this.waitForChallenge();
    // Give the story list time to render.
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(1500);

    const articles = await this.page.evaluate(() => {
      const results: { title: string; content: string; url: string; publishDate: string; tags: string[] }[] = [];
      const seen = new Set<string>();

      const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];
      for (const a of anchors) {
        const url = (a.href || '').split('?')[0];
        const text = (a.textContent || '').trim();
        // A published story link looks like /@user/slug-<hexid> or /pub/slug-<hexid>
        const isStory = /\/[^/]+\/.+-[0-9a-f]{6,}$/.test(url) || /\/p\/[0-9a-f]+$/.test(url);
        if (!isStory || text.length < 8) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({ title: text, content: '', url, publishDate: '', tags: [] });
      }
      return results;
    });

    await this.persistState();
    return articles;
  }

  /** Fetch the full text of a single article URL. */
  async getArticleContent(url: string, requireLogin: boolean = true): Promise<string> {
    if (requireLogin) {
      if (!(await this.ensureLoggedIn())) {
        throw new Error('Medium login was not completed (timed out or cancelled).');
      }
    } else {
      await this.ensureBrowser(true);
    }
    if (!this.page) throw new Error('Browser not initialized');

    console.error(`📖 Fetching article content from: ${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.waitForChallenge();
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(1500);

    const content = await this.page.evaluate(() => {
      const selectors = [
        'article section p',
        '[data-testid="story-content"] p',
        'article p',
        'main p',
        '[role="main"] p',
      ];
      for (const selector of selectors) {
        const els = document.querySelectorAll(selector);
        if (els.length > 3) {
          const paragraphs: string[] = [];
          els.forEach(el => {
            const text = el.textContent?.trim();
            if (text && text.length > 20) paragraphs.push(text);
          });
          if (paragraphs.length > 2) return paragraphs.join('\n\n');
        }
      }
      for (const selector of ['article', 'main', '[role="main"]']) {
        const el = document.querySelector(selector);
        const text = el?.textContent?.trim();
        if (text && text.length > 200) return text.replace(/\s+/g, ' ').substring(0, 8000);
      }
      const pageText = document.body.textContent?.toLowerCase() || '';
      if (/member-only|become a member|sign up to continue|subscribe to read/.test(pageText)) {
        return 'Content appears to be behind a paywall / member-only.';
      }
      return 'Unable to extract article content (unsupported layout or paywall).';
    });

    console.error(`✅ Content extracted (${content.length} chars).`);
    await this.persistState();
    return content;
  }

  /** Publish (or draft) a new article via the Medium editor. */
  async publishArticle(options: PublishOptions): Promise<{ success: boolean; url?: string; error?: string }> {
    if (!(await this.ensureLoggedIn())) {
      return { success: false, error: 'Medium login was not completed (timed out or cancelled).' };
    }
    if (!this.page) throw new Error('Browser not initialized');

    try {
      await this.page.goto('https://medium.com/new-story', { waitUntil: 'domcontentloaded' });
      await this.waitForChallenge();
      await this.page.waitForLoadState('networkidle').catch(() => {});

      await this.page.waitForSelector('[data-testid="richTextEditor"]', { timeout: 15000 });

      const titleSelector = '[data-testid="richTextEditor"] h1, [placeholder*="Title"], .graf--title';
      await this.page.waitForSelector(titleSelector);
      await this.page.click(titleSelector);
      await this.page.fill(titleSelector, options.title);

      const contentSelector = '[data-testid="richTextEditor"] p, .graf--p';
      await this.page.waitForSelector(contentSelector);
      await this.page.click(contentSelector);

      const paragraphs = options.content.split('\n\n').filter(p => p.trim());
      for (let i = 0; i < paragraphs.length; i++) {
        if (i > 0) {
          await this.page.keyboard.press('Enter');
          await this.page.keyboard.press('Enter');
        }
        await this.page.keyboard.type(paragraphs[i]);
      }

      if (options.tags && options.tags.length > 0) {
        const publishButton = this.page.locator('button:has-text("Publish"), [data-testid="publish-button"]').first();
        if (await publishButton.isVisible()) {
          await publishButton.click();
          await this.page.waitForSelector('[data-testid="tag-input"], input[placeholder*="tag"]', { timeout: 5000 });
          for (const tag of options.tags) {
            await this.page.fill('[data-testid="tag-input"], input[placeholder*="tag"]', tag);
            await this.page.keyboard.press('Enter');
          }
        }
      }

      if (options.isDraft) {
        const saveButton = this.page.locator('button:has-text("Save draft"), [data-testid="save-draft"]').first();
        if (await saveButton.isVisible()) await saveButton.click();
        await this.persistState();
        return { success: true };
      }

      const finalPublishButton = this.page
        .locator('button:has-text("Publish now"), [data-testid="publish-now"]')
        .first();
      if (await finalPublishButton.isVisible()) {
        await finalPublishButton.click();
        await this.page.waitForLoadState('networkidle').catch(() => {});
        await this.persistState();
        return { success: true, url: this.page.url() };
      }

      return { success: false, error: 'Could not find publish button' };
    } catch (error) {
      return { success: false, error: `Publishing failed: ${error}` };
    }
  }

  /** Search Medium (no login required). */
  async searchMediumArticles(keywords: string[]): Promise<MediumArticle[]> {
    await this.ensureBrowser(true);
    if (!this.page) throw new Error('Browser not initialized');

    const searchQuery = keywords.join(' ');
    console.error(`🔍 Searching Medium for: "${searchQuery}"`);

    await this.page.goto(`https://medium.com/search?q=${encodeURIComponent(searchQuery)}`, {
      waitUntil: 'domcontentloaded',
    });
    await this.waitForChallenge();
    await this.page.waitForLoadState('networkidle').catch(() => {});
    await this.page.waitForTimeout(1500);

    const articles = await this.page.evaluate(() => {
      const results: any[] = [];
      const seen = new Set<string>();
      const anchors = Array.from(document.querySelectorAll('a')) as HTMLAnchorElement[];

      for (const a of anchors) {
        let href = a.href || '';
        const text = (a.textContent || '').trim();
        if (href.includes('redirect=')) {
          const m = href.match(/redirect=([^&]+)/);
          if (m) href = decodeURIComponent(m[1]);
        }
        href = href.split('?')[0];

        const looksLikeArticle = /\/[^/]+\/.+-[0-9a-f]{6,}$/.test(href) || /\/p\/[0-9a-f]+$/.test(href);
        const isJunk = /\/(signin|signup|search|bookmark|tag|me)\b/.test(href);
        if (looksLikeArticle && !isJunk && text.length > 12 && !seen.has(href)) {
          seen.add(href);
          results.push({ title: text, content: '', url: href, publishDate: '', tags: [], claps: 0 });
        }
      }
      return results;
    });

    console.error(`🎉 Search completed. Found ${articles.length} articles.`);
    return articles;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
      this.currentHeadless = null;
    }
  }
}
