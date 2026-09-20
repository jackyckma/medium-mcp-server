import 'dotenv/config';
import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';

// Configurable via environment
const HEADLESS = process.env.MEDIUM_HEADLESS === '1' || process.env.MEDIUM_HEADLESS === 'true';
const configuredContentLength = Number(process.env.MEDIUM_MAX_CONTENT_LENGTH || '50000');
const MAX_CONTENT_LENGTH = Number.isSafeInteger(configuredContentLength) && configuredContentLength > 0
  ? configuredContentLength : 50000;

function isAllowedMediumUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (host === 'medium.com' || host.endsWith('.medium.com'));
  } catch {
    return false;
  }
}

export interface MediumArticle {
  title: string;
  content: string;
  url?: string;
  publishDate?: string;
  tags?: string[];
  claps?: number | null;
}

export interface PublishOptions {
  title: string;
  content: string;
  tags?: string[];
  isDraft?: boolean;
}

export class BrowserMediumClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sessionPath = join(process.cwd(), 'medium-session.json');
  private initialization: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    if (this.browser) return;
    this.initialization = this.initializeBrowser();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  private async initializeBrowser(): Promise<void> {
    try {
      this.browser = await chromium.launch({
        headless: HEADLESS,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=VizDisplayCompositor',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
          '--disable-dev-shm-usage'
        ]
      });

      const contextOptions: any = {
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      };

      if (existsSync(this.sessionPath)) {
        try {
          const sessionData = JSON.parse(readFileSync(this.sessionPath, 'utf8'));
          contextOptions.storageState = sessionData;
        } catch (error) {
          console.error('Failed to load session:', error);
        }
      }

      this.context = await this.browser.newContext(contextOptions);

      await this.context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
        delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
      });

      this.page = await this.context.newPage();
    } catch (error) {
      try {
        await this.browser?.close();
      } finally {
        this.browser = null;
        this.context = null;
        this.page = null;
      }
      throw error;
    }
  }

  async ensureLoggedIn(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');

    await this.page.goto('https://medium.com', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);
    
    // Check if we're logged in by looking for user-specific elements
    try {
      // Try multiple selectors for logged-in state
      const loginSelectors = [
        '[data-testid="headerUserButton"]',
        '[data-testid="user-menu"]',
        'a[href="/me/stories"]'
      ];
      
      let isLoggedIn = false;
      for (const selector of loginSelectors) {
        try {
          await this.page.waitForSelector(selector, { timeout: 3000 });
          console.error(`✅ Login detected using selector: ${selector}`);
          isLoggedIn = true;
          break;
        } catch {
          // Try next selector
        }
      }
      
      if (isLoggedIn) {
        console.error('✅ Already logged in to Medium');
        await this.saveSession();
        return true;
      } else {
        throw new Error('Not logged in');
      }
    } catch {
      console.error('❌ Not logged in. Please log in manually...');
      
      if (HEADLESS) return false;

      // Navigate to login page
      await this.page.goto('https://medium.com/m/signin');
      
      // Wait for user to complete login
      console.error('⏳ Waiting for you to complete login in the browser...');
      console.error('');
      console.error('🔐 LOGIN INSTRUCTIONS:');
      console.error('   1. In the opened browser, choose "Sign in with email"');
      console.error('   2. Use your Medium email/password (avoid Google login if possible)');
      console.error('   3. If you must use Google login:');
      console.error('      - Try clicking "Sign in with Google"');
      console.error('      - If blocked, manually navigate to medium.com in a regular browser');
      console.error('      - Login there first, then come back to this automated browser');
      console.error('   4. Complete any 2FA if prompted');
      console.error('   5. The script will continue automatically once logged in...');
      console.error('');
      
      // Wait for successful login (user button appears)
      try {
        await this.page.waitForSelector('[data-testid="headerUserButton"], [data-testid="user-menu"], a[href="/me/stories"]', { timeout: 300000 }); // 5 minutes
        console.error('✅ Login successful!');
        await this.saveSession();
        return true;
      } catch (error) {
        console.error('❌ Login timeout. Please try again.');
        return false;
      }
    }
  }

  async saveSession(): Promise<void> {
    if (!this.context) return;
    
    try {
      const sessionData = await this.context.storageState();
      writeFileSync(this.sessionPath, JSON.stringify(sessionData, null, 2), { mode: 0o600 });
      chmodSync(this.sessionPath, 0o600);
      console.error('💾 Session saved for future use');
    } catch (error) {
      console.error('Failed to save session:', error);
    }
  }

  async getUserArticles(): Promise<MediumArticle[]> {
    if (!this.page) throw new Error('Browser not initialized');
    
    await this.ensureLoggedIn();
    
    // Navigate to user's stories
    await this.page.goto('https://medium.com/me/stories/public', { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);

    // Extract article information
    const articles = await this.page.evaluate(() => {
      const articleElements = document.querySelectorAll('[data-testid="story-preview"]');
      const articles: MediumArticle[] = [];

      articleElements.forEach(element => {
        try {
          const titleElement = element.querySelector('h3, h2, [data-testid="story-title"]');
          const linkElement = element.querySelector('a[href*="/"]');
          const dateElement = element.querySelector('[data-testid="story-publish-date"], time');
          
          if (titleElement && linkElement) {
            articles.push({
              title: titleElement.textContent?.trim() || '',
              content: '', // We'll need to fetch full content separately
              url: (linkElement as HTMLAnchorElement).href,
              publishDate: dateElement?.textContent?.trim() || '',
              tags: []
            });
          }
        } catch (error) {
          console.error('Error extracting article:', error);
        }
      });

      return articles;
    });

    return articles;
  }

  async getArticleContent(url: string, requireLogin: boolean = true): Promise<string> {
    if (!this.page || !this.context) throw new Error('Browser not initialized');

    if (!isAllowedMediumUrl(url)) {
      throw new Error(`Refusing to navigate to non-Medium HTTPS URL: ${url}`);
    }
    
    console.error(`📖 Fetching article content from: ${url}`);
    
    if (requireLogin) {
      try {
        await this.ensureLoggedIn();
      } catch (error) {
        console.error('Login unavailable; attempting public article access:', error);
      }
    }

    const articlePage = await this.context.newPage();
    try {
      console.error(`🌐 Navigating to article (new tab): ${url}`);
      await articlePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for Cloudflare challenge to resolve, then for real article content.
      // Poll: check if page is on Cloudflare challenge, wait until it clears.
      let cfCleared = false;
      for (let attempt = 0; attempt < 15; attempt++) {
        await articlePage.waitForTimeout(2000);
        const state = await articlePage.evaluate(() => ({
          isCF: document.title === 'Just a moment...' ||
                document.body?.innerText?.includes('security verification') ||
                document.body?.innerText?.includes('Enable JavaScript and cookies'),
          hasArticle: document.querySelectorAll('article p, article section p').length > 3,
          title: document.querySelector('article h1')?.textContent?.trim()?.substring(0, 40),
        })).catch(() => ({ isCF: false, hasArticle: false }));
        if (state.hasArticle) { cfCleared = true; break; }
        if (state.isCF && attempt === 0) console.error('⏳ Cloudflare challenge detected, waiting...');
        if (!state.isCF && !state.hasArticle && attempt > 3) {
          console.error('⚠️ No Cloudflare but no article content either');
          break;
        }
      }
      if (!cfCleared) console.error('⚠️ Could not load article content (Cloudflare or paywall)');
      
      console.error('📄 Page loaded, extracting content...');

      // Extract article content with multiple strategies
      const content = await articlePage.evaluate(() => {
        const log = (...args: any[]) => {
          // Silent in browser context to avoid JSON interference
        };
        
        log('🔍 Starting content extraction...');
        
        // Strategy 1: Try modern Medium article selectors
        const modernSelectors = [
          'article section p',
          'article div[data-testid="story-content"] p',
          '[data-testid="story-content"] p',
          'article section div p',
          'article p'
        ];
        
        // Strategy 2: Try classic Medium selectors
        const classicSelectors = [
          '.postArticle-content p',
          '.section-content p',
          '.graf--p',
          '.postArticle p'
        ];
        
        // Strategy 3: Generic content selectors
        const genericSelectors = [
          'main p',
          '[role="main"] p',
          '.story p',
          '.post p'
        ];
        
        const allSelectors = [...modernSelectors, ...classicSelectors, ...genericSelectors];
        let extractedContent = '';
        
        // Try each selector strategy
        for (const selector of allSelectors) {
          const elements = document.querySelectorAll(selector);
          log(`🎯 Selector "${selector}" found ${elements.length} paragraphs`);
          
          if (elements.length > 3) { // Need at least a few paragraphs for meaningful content
            const paragraphs: string[] = [];
            
            elements.forEach((element, index) => {
              const text = element.textContent?.trim();
              if (text && text.length > 20) { // Filter out very short paragraphs
                paragraphs.push(text);
              }
            });
            
            if (paragraphs.length > 2) { // Need meaningful content
              extractedContent = paragraphs.join('\n\n');
              log(`✅ Successfully extracted ${paragraphs.length} paragraphs using: ${selector}`);
              break;
            }
          }
        }
        
        // Fallback: Try to get any substantial text content
        if (!extractedContent) {
          log('🔄 Trying fallback content extraction...');
          
          const fallbackSelectors = [
            'article',
            'main',
            '[role="main"]',
            '.story',
            '.post'
          ];
          
          for (const selector of fallbackSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const text = element.textContent?.trim();
              if (text && text.length > 200) {
                // Clean up the text a bit
                extractedContent = text
                  .replace(/\s+/g, ' ') // Normalize whitespace
                  .replace(/(.{100})/g, '$1\n\n');
                
                log(`✅ Fallback extraction successful using: ${selector}`);
                break;
              }
            }
          }
        }
        
        // Debug info if still no content
        if (!extractedContent) {
          log('❌ No content found. Page analysis:');
          log('Page title:', document.title);
          log('Page URL:', window.location.href);
          log('Body text length:', document.body.textContent?.length || 0);
          
          // Check if we hit a paywall or login requirement
          const paywallIndicators = [
            'sign up',
            'subscribe',
            'member-only',
            'paywall',
            'premium',
            'upgrade'
          ];
          
          const pageText = document.body.textContent?.toLowerCase() || '';
          const foundIndicators = paywallIndicators.filter(indicator => 
            pageText.includes(indicator)
          );
          
          if (foundIndicators.length > 0) {
            log('🚫 Possible paywall detected:', foundIndicators);
            return `Content may be behind a paywall or require login. Found indicators: ${foundIndicators.join(', ')}`;
          }
          
          return 'Unable to extract article content. The article may be behind a paywall, require login, or use an unsupported layout.';
        }
        
        // Check if we might be getting only a preview (very short content)
        if (extractedContent.length < 500) {
          log('⚠️  Warning: Content seems short, might be preview only');
          
          // Look for "continue reading" or member-only indicators
          const previewIndicators = [
            'continue reading',
            'read more',
            'member-only story',
            'this story is for members only',
            'become a member',
            'sign up to continue',
            'subscribe to read'
          ];
          
          const pageText = document.body.textContent?.toLowerCase() || '';
          const foundPreviewIndicators = previewIndicators.filter(indicator => 
            pageText.includes(indicator)
          );
          
          if (foundPreviewIndicators.length > 0) {
            log('🔒 Preview-only content detected:', foundPreviewIndicators);
            extractedContent = `[PREVIEW ONLY - Login required for full content]\n\n${extractedContent}\n\n[This appears to be only a preview. The full article requires Medium membership or login. Found indicators: ${foundPreviewIndicators.join(', ')}]`;
          }
        }
        
        log(`📊 Final content length: ${extractedContent.length} characters`);
        return extractedContent;
      });

      console.error(`✅ Content extraction completed. Length: ${content.length} characters`);
      if (content.length > MAX_CONTENT_LENGTH) {
        return `${content.slice(0, MAX_CONTENT_LENGTH)}\n\n[TRUNCATED: ${MAX_CONTENT_LENGTH} of ${content.length} characters; adjust MEDIUM_MAX_CONTENT_LENGTH to retrieve more.]`;
      }
      return content;
      
    } catch (error) {
      console.error('❌ Error fetching article content:', error);
      throw new Error(`Failed to fetch article content: ${error}`);
    } finally {
      await articlePage.close();
    }
  }

  async publishArticle(options: PublishOptions): Promise<{ success: boolean; url?: string; error?: string }> {
    if (!this.page) throw new Error('Browser not initialized');
    
    await this.ensureLoggedIn();

    try {
      // Navigate to the new story page
      await this.page.goto('https://medium.com/new-story');
      await this.page.waitForLoadState('networkidle');

      // Wait for the editor to load
      await this.page.waitForSelector('[data-testid="richTextEditor"]', { timeout: 10000 });

      // Add title
      const titleSelector = '[data-testid="richTextEditor"] h1, [placeholder*="Title"], .graf--title';
      await this.page.waitForSelector(titleSelector);
      await this.page.click(titleSelector);
      await this.page.fill(titleSelector, options.title);

      // Add content
      const contentSelector = '[data-testid="richTextEditor"] p, .graf--p';
      await this.page.waitForSelector(contentSelector);
      await this.page.click(contentSelector);
      
      // Split content into paragraphs and add them
      const paragraphs = options.content.split('\n\n').filter(p => p.trim());
      for (let i = 0; i < paragraphs.length; i++) {
        if (i > 0) {
          await this.page.keyboard.press('Enter');
          await this.page.keyboard.press('Enter');
        }
        await this.page.keyboard.type(paragraphs[i]);
      }

      // Add tags if provided
      if (options.tags && options.tags.length > 0) {
        // Look for publish button to access settings
        const publishButton = await this.page.locator('button:has-text("Publish"), [data-testid="publish-button"]').first();
        if (await publishButton.isVisible()) {
          await publishButton.click();
          
          // Wait for publish modal and add tags
          await this.page.waitForSelector('[data-testid="tag-input"], input[placeholder*="tag"]', { timeout: 5000 });
          
          for (const tag of options.tags) {
            await this.page.fill('[data-testid="tag-input"], input[placeholder*="tag"]', tag);
            await this.page.keyboard.press('Enter');
          }
        }
      }

      if (options.isDraft) {
        // Save as draft
        const saveButton = await this.page.locator('button:has-text("Save draft"), [data-testid="save-draft"]').first();
        if (await saveButton.isVisible()) {
          await saveButton.click();
        }
        return { success: true };
      } else {
        // Publish the article
        const finalPublishButton = await this.page.locator('button:has-text("Publish now"), [data-testid="publish-now"]').first();
        if (await finalPublishButton.isVisible()) {
          await finalPublishButton.click();
          
          // Wait for success and get URL
          await this.page.waitForLoadState('networkidle');
          const currentUrl = this.page.url();
          
          return { success: true, url: currentUrl };
        }
      }

      return { success: false, error: 'Could not find publish button' };

    } catch (error) {
      return { success: false, error: `Publishing failed: ${error}` };
    }
  }

  async searchMediumArticles(keywords: string[]): Promise<MediumArticle[]> {
    if (!this.page) throw new Error('Browser not initialized');
    
    const searchQuery = keywords.join(' ');
    console.error(`🔍 Searching Medium for: "${searchQuery}"`);
    
    // Try to use saved session if available (but don't force login for search)
    if (existsSync(this.sessionPath)) {
      console.error('💾 Using saved session for search...');
    }
    
    await this.page.goto(`https://medium.com/search?q=${encodeURIComponent(searchQuery)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Wait for content to render (Cloudflare challenge may add delay)
    try {
      await this.page.waitForSelector('article', { timeout: 15000 });
    } catch {
      // Cloudflare or slow render — give it more time
      console.error('⏳ No articles yet, waiting for Cloudflare/render...');
      await this.page.waitForTimeout(5000);
    }

    console.error('📄 Current page URL:', this.page.url());

    // Scroll to load more results (lazy-loaded feed)
    const maxScrolls = 5;
    let prevCount = 0;
    for (let s = 0; s < maxScrolls; s++) {
      await this.page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await this.page.waitForTimeout(1500);
      const count = await this.page.evaluate(() => document.querySelectorAll('article').length);
      console.error(`📉 Scroll ${s + 1}/${maxScrolls}: ${count} articles loaded`);
      if (count === prevCount) break; // No new content, stop scrolling
      prevCount = count;
    }

    const articles = await this.page.evaluate((searchQuery) => {
      // Remove console.log from browser context to avoid JSON interference
      const log = (...args: any[]) => {
        // Silent in browser context
      };
      
      log('🔎 Starting search extraction for:', searchQuery);
      
      // Try multiple selectors for different Medium layouts
      const possibleSelectors = [
        // Modern Medium selectors
        'article',
        '[data-testid="story-preview"]',
        '[data-testid="story-card"]',
        '.js-postListItem',
        '.postArticle',
        '.streamItem',
        '.js-streamItem',
        // Fallback selectors
        'div[role="article"]',
        '.story-preview',
        '.post-preview'
      ];

      const articleUrl = (raw: string): string => {
        try {
          const valid = (url: URL) => url.protocol === 'https:' &&
            (url.hostname === 'medium.com' || url.hostname.endsWith('.medium.com')) &&
            !url.username && !url.password && !url.port;
          let url = new URL(raw, 'https://medium.com');
          if (!valid(url)) return '';
          const redirect = url.searchParams.get('redirect');
          if (redirect) url = new URL(redirect, url.origin);
          if (!valid(url) || /(?:^|\/)(?:signin|signup)(?:\/|$)/i.test(url.pathname)) return '';
          url.search = '';
          url.hash = '';
          return url.href;
        } catch {
          return '';
        }
      };

      const articles: any[] = [];
      let elementsFound = 0;

      for (const selector of possibleSelectors) {
        const elements = document.querySelectorAll(selector);
        log(`🎯 Selector "${selector}" found ${elements.length} elements`);
        
        if (elements.length > 0) {
          elementsFound += elements.length;
          
          elements.forEach((element, index) => {
            try {
              // Try multiple title selectors
              const titleSelectors = [
                'h1', 'h2', 'h3', 'h4',
                '[data-testid="story-title"]',
                '.graf--title',
                '.story-title',
                '.post-title',
                'a[data-action="show-post"]'
              ];

              let titleElement = null;
              let titleText = '';

              for (const titleSel of titleSelectors) {
                titleElement = element.querySelector(titleSel);
                if (titleElement && titleElement.textContent?.trim()) {
                  titleText = titleElement.textContent.trim();
                  break;
                }
              }

              // Try multiple approaches to find the actual article URL
              let linkUrl = '';

              // Strategy 1 (BEST): The <a> wrapping the title element is the article link.
              // This is the canonical Medium title-link pattern — stable across layouts.
              if (titleElement && (titleElement as HTMLElement).closest) {
                const titleAnchor = (titleElement as HTMLElement).closest('a');
                if (titleAnchor && (titleAnchor as HTMLAnchorElement).href) {
                  linkUrl = articleUrl((titleAnchor as HTMLAnchorElement).href);
                }
              }

              // Strategy 2: Any <a> containing an h2/h3 (title link without closest support)
              if (!linkUrl) {
                const titleLink = element.querySelector('a:has(h2), a:has(h3)');
                if (titleLink && (titleLink as HTMLAnchorElement).href) {
                  linkUrl = articleUrl((titleLink as HTMLAnchorElement).href);
                }
              }

              // Strategy 3: Find a link whose path ends with a hex article ID (slug-xxxxxxxxxxxx)
              // Medium article IDs are 12 hex chars; publi/author/profile links never have this.
              if (!linkUrl) {
                const allLinks = Array.from(element.querySelectorAll('a'));
                for (const anchor of allLinks) {
                  const candidate = articleUrl((anchor as HTMLAnchorElement).href);
                  if (candidate && /-[a-f0-9]{8,}$/.test(new URL(candidate).pathname)) {
                    linkUrl = candidate;
                    break;
                  }
                }
              }

              // Strategy 4 (fallback): data-href attribute
              if (!linkUrl) {
                const dataHrefElement = element.querySelector('[data-href]');
                if (dataHrefElement) {
                  const dataHref = dataHrefElement.getAttribute('data-href');
                  if (dataHref) {
                    linkUrl = articleUrl(dataHref);
                  }
                }
              }

              // Try to get author info
              const authorSelectors = [
                '[data-testid="story-author"]',
                '.postMetaInline-authorLockup',
                '.story-author',
                '.author-name',
                'a[href*="/@"]',  // Author profile link on modern Medium
              ];

              let authorText = '';
              for (const authorSel of authorSelectors) {
                const authorElement = element.querySelector(authorSel);
                if (authorElement && authorElement.textContent?.trim()) {
                  // For /@username links, extract the display name (not the URL)
                  const text = authorElement.textContent.trim();
                  if (text.length > 1 && text.length < 100) {
                    authorText = text;
                    break;
                  }
                }
              }

              // Try to get snippet/preview (subtitle on modern Medium is h3, after the h2 title)
              const snippetSelectors = [
                'h3',                   // Subtitle/preview on modern Medium search
                '.story-excerpt',
                '.post-excerpt',
                '.graf--p',
              ];

              let snippetText = '';
              for (const snippetSel of snippetSelectors) {
                const snippetElement = element.querySelector(snippetSel);
                if (snippetElement && snippetElement.textContent?.trim() && snippetElement !== titleElement) {
                  snippetText = snippetElement.textContent.trim().substring(0, 200);
                  break;
                }
              }

              // Extract date from spans matching common date patterns
              const dateSpans = Array.from(element.querySelectorAll('span'));
              const datePattern = /^(Today|Yesterday|\d{1,2}\s*(d|hr|h)\s*ago|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2})$/i;
              let dateText = '';
              for (const sp of dateSpans) {
                const t = sp.textContent?.trim();
                if (t && datePattern.test(t)) { dateText = t; break; }
              }

              log(`📝 Article ${index + 1}:`, {
                title: titleText,
                url: linkUrl,
                author: authorText,
                snippet: snippetText.substring(0, 50) + '...',
                date: dateText,
                claps: null,
              });

              if (titleText && linkUrl) {
                articles.push({
                  title: titleText,
                  content: snippetText,
                  url: linkUrl,
                  publishDate: dateText,
                  tags: [],
                  claps: null,
                });
              }
            } catch (error) {
              log('❌ Error extracting article:', error);
            }
          });

          // If we found articles with this selector, we can break
          if (articles.length > 0) {
            log(`✅ Successfully extracted ${articles.length} articles using selector: ${selector}`);
            break;
          }
        }
      }

      log(`📊 Total elements found: ${elementsFound}, Articles extracted: ${articles.length}`);
      
      // If no articles found, let's debug what's on the page
      if (articles.length === 0) {
        log('🔍 Debug: Page structure analysis');
        log('Page title:', document.title);
        log('Page text content preview:', document.body.textContent?.substring(0, 500));
        
        // Look for any text that might indicate search results
        const searchResultIndicators = [
          'No stories found',
          'No results',
          'Try different keywords',
          'stories found',
          'results for'
        ];
        
        const pageText = document.body.textContent?.toLowerCase() || '';
        for (const indicator of searchResultIndicators) {
          if (pageText.includes(indicator.toLowerCase())) {
            log(`📍 Found indicator: "${indicator}"`);
          }
        }
      }

      return articles;
    }, searchQuery);

    console.error(`🎉 Search completed. Found ${articles.length} articles`);
    return articles;
  }

  async close(): Promise<void> {
    await this.initialization?.catch(() => {});
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
} 