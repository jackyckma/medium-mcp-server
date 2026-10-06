import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { marked } from 'marked';

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

export class BrowserMediumClient {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sessionPath = join(process.cwd(), 'medium-session.json');

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({ 
      headless: false, // Keep visible for login
      slowMo: 100, // Slow down for reliability
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor',
        '--disable-web-security',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    });

    // Load existing session if available
    const contextOptions: any = {
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9'
      }
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
    
    // Add script to remove webdriver property
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      
      // Remove automation indicators
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });
    
    this.page = await this.context.newPage();
  }

  async ensureLoggedIn(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');

    // First check if we have a saved session
    if (existsSync(this.sessionPath)) {
      console.error('💾 Found existing session file, testing login status...');
    }

    // Try a simpler page first to check login status
    await this.page.goto('https://medium.com');
    await this.page.waitForLoadState('networkidle');
    
    // Check if we're logged in by looking for user-specific elements
    try {
      // Try multiple selectors for logged-in state
      const loginSelectors = [
        '[data-testid="headerUserButton"]',
        '.avatar',
        '[data-testid="user-menu"]',
        'button[aria-label*="user"]',
        'img[alt*="avatar"]',
        '[data-testid="write-button"]', // Write button only appears when logged in
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
        await this.page.waitForSelector('[data-testid="headerUserButton"], .avatar, [data-testid="user-menu"]', { timeout: 300000 }); // 5 minutes
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
      writeFileSync(this.sessionPath, JSON.stringify(sessionData, null, 2));
      console.error('💾 Session saved for future use');
    } catch (error) {
      console.error('Failed to save session:', error);
    }
  }

  async getUserArticles(): Promise<MediumArticle[]> {
    if (!this.page) throw new Error('Browser not initialized');
    
    await this.ensureLoggedIn();
    
    // Navigate to user's stories
    await this.page.goto('https://medium.com/me/stories/public');
    await this.page.waitForLoadState('networkidle');

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
    if (!this.page) throw new Error('Browser not initialized');
    
    console.error(`📖 Fetching article content from: ${url}`);
    
    // Check if we have a saved session first
    let isLoggedIn = false;
    if (existsSync(this.sessionPath)) {
      console.error('💾 Found saved session, checking if still valid...');
      
      // Quick check: try to access Medium homepage and look for login indicators
      try {
        await this.page.goto('https://medium.com');
        await this.page.waitForLoadState('networkidle');
        
        // Try to find login indicators quickly
        const loginIndicators = [
          '[data-testid="headerUserButton"]',
          '[data-testid="write-button"]',
          'a[href="/me/stories"]'
        ];
        
        for (const selector of loginIndicators) {
          try {
            await this.page.waitForSelector(selector, { timeout: 2000 });
            console.error('✅ Session is still valid, user is logged in');
            isLoggedIn = true;
            break;
          } catch {
            // Try next selector
          }
        }
      } catch (error) {
        console.error('⚠️  Could not verify session validity');
      }
    }
    
    if (!isLoggedIn && requireLogin) {
      console.error('🔐 Not logged in. Attempting login for full content access...');
      isLoggedIn = await this.ensureLoggedIn();
    } else if (!isLoggedIn && !requireLogin) {
      console.error('🔓 Skipping login as requested. Will get preview content only.');
    }
    
    if (!isLoggedIn) {
      console.error('⚠️  Warning: Login failed or skipped. You may only get partial content (preview).');
    } else {
      console.error('✅ Ready to fetch full article content with login session');
    }
    
    try {
      console.error(`🌐 Navigating to article: ${url}`);
      await this.page.goto(url, { waitUntil: 'networkidle' });
      
      // Wait a bit more for dynamic content
      await this.page.waitForTimeout(3000);
      
      console.error('📄 Page loaded, extracting content...');

      // Extract article content with multiple strategies
      const content = await this.page.evaluate(() => {
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
                  .replace(/(.{100})/g, '$1\n\n') // Add paragraph breaks
                  .substring(0, 5000); // Limit length
                
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
      return content;
      
    } catch (error) {
      console.error('❌ Error fetching article content:', error);
      throw new Error(`Failed to fetch article content: ${error}`);
    }
  }

  /**
   * Paste HTML (or an image file) into the focused Medium editor. Medium's editor
   * converts pasted HTML into native blocks (headings, lists, code blocks) and
   * uploads pasted image files to its own CDN.
   */
  private async pasteHtml(html: string): Promise<void> {
    await this.page!.evaluate((h) => {
      const dt = new DataTransfer();
      dt.setData('text/html', h);
      dt.setData('text/plain', h.replace(/<[^>]+>/g, ''));
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    }, html);
    await this.page!.waitForTimeout(1000);
  }

  /**
   * Markdown -> HTML shaped for Medium's paste handler. Medium splits a pasted <pre>
   * at every blank line, so blank lines inside code get a single space; and a
   * blockquote must hold bare text (inner <p>/newlines render as empty quote blocks).
   */
  private async markdownToEditorHtml(markdown: string): Promise<string> {
    const html = await marked.parse(markdown);
    return html
      .replace(/<pre>[\s\S]*?<\/pre>/g, (pre) => pre.replace(/\n(?=\n)/g, '\n '))
      .replace(/<blockquote>\s*<p>([\s\S]*?)<\/p>\s*<\/blockquote>/g, '<blockquote>$1</blockquote>');
  }

  private async pasteImage(path: string): Promise<void> {
    const base64 = readFileSync(path).toString('base64');
    const before = await this.page!.locator('.postArticle-content img.graf-image').count();
    await this.page!.evaluate(({ b64, name }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], name, { type: 'image/png' }));
      document.activeElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
    }, { b64: base64, name: basename(path) });
    // Wait until the upload finishes and the image is served from Medium's CDN
    await this.page!.waitForFunction(
      (n) => {
        const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.postArticle-content img.graf-image'));
        return imgs.length > n && imgs.every(i => i.src.includes('cdn-images'));
      },
      before,
      { timeout: 60000 }
    );
  }

  /**
   * Content is Markdown. Local images (`![alt](/absolute/path.png)`) are uploaded
   * through the editor. Medium autosaves everything as a draft, so isDraft just
   * stops before the publish flow and returns the draft's edit URL.
   */
  async publishArticle(options: PublishOptions): Promise<{ success: boolean; url?: string; error?: string }> {
    if (!this.page) throw new Error('Browser not initialized');

    await this.ensureLoggedIn();

    try {
      await this.page.goto('https://medium.com/new-story');
      const titleSelector = '.postArticle-content[contenteditable="true"] h3.graf--title';
      // Medium's editor occasionally fails to mount on first load; reload once before giving up
      try {
        await this.page.waitForSelector(titleSelector, { timeout: 20000 });
      } catch {
        await this.page.reload();
        await this.page.waitForSelector(titleSelector, { timeout: 30000 });
      }

      await this.page.click(titleSelector);
      await this.page.keyboard.type(options.title);
      await this.page.keyboard.press('Enter');

      // Paste the whole document once, with a placeholder paragraph where each
      // image goes; then swap each placeholder for its uploaded image in place.
      const imageRe = /!\[[^\]]*\]\((\/[^)\s]+\.(?:png|jpe?g|gif))\)/gi;
      const images: string[] = [];
      const withTokens = options.content.replace(imageRe, (_m, path: string) => {
        if (!existsSync(path)) throw new Error(`Image not found: ${path}`);
        images.push(path);
        return `\n\nIMGTOKEN${images.length - 1}X\n\n`;
      });
      await this.pasteHtml(await this.markdownToEditorHtml(withTokens));
      await this.page.waitForTimeout(1500);

      for (let i = 0; i < images.length; i++) {
        // Select the placeholder text through the DOM (a mouse click can be intercepted
        // by a neighbouring figure), delete it, and leave the caret in the empty paragraph
        const found = await this.page.evaluate((tok) => {
          const editor = document.querySelector<HTMLElement>('.postArticle-content[contenteditable="true"]');
          const el = Array.from(document.querySelectorAll<HTMLElement>('.postArticle-content p.graf'))
            .find(p => p.textContent?.trim() === tok);
          if (!editor || !el) return false;
          editor.focus();
          el.scrollIntoView({ block: 'center' });
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
          return true;
        }, `IMGTOKEN${i}X`);
        if (!found) throw new Error(`Image placeholder ${i} not found in editor`);
        await this.page.keyboard.press('Backspace');
        await this.pasteImage(images[i]);
      }

      // Give Medium's autosave time to persist the draft
      await this.page.waitForURL(/\/p\/[0-9a-f]+\/edit/, { timeout: 30000 });
      await this.page.waitForTimeout(3000);
      const draftUrl = this.page.url();

      if (options.isDraft) {
        return { success: true, url: draftUrl };
      }

      // Live publish: open the publish dialog, add tags, confirm
      await this.page.locator('button:has-text("Publish")').first().click();
      await this.page.waitForTimeout(2000);
      if (options.tags?.length) {
        const tagInput = this.page.locator('[data-testid="publishTopicsInput"], input[placeholder*="topic" i], input[placeholder*="tag" i]').first();
        for (const tag of options.tags.slice(0, 5)) {
          await tagInput.fill(tag);
          await this.page.keyboard.press('Enter');
        }
      }
      await this.page.locator('button:has-text("Publish now")').first().click();
      await this.page.waitForLoadState('networkidle');
      return { success: true, url: this.page.url() };
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
    
    await this.page.goto(`https://medium.com/search?q=${encodeURIComponent(searchQuery)}`);
    await this.page.waitForLoadState('networkidle');
    
    // Wait a bit more for dynamic content to load
    await this.page.waitForTimeout(2000);

    console.error('📄 Current page URL:', this.page.url());

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
              
              // Strategy 1: Look for data-href attribute (most reliable for articles)
              const dataHrefElement = element.querySelector('[data-href]');
              if (dataHrefElement) {
                const dataHref = dataHrefElement.getAttribute('data-href');
                if (dataHref && dataHref.includes('medium.com') && dataHref.includes('-')) {
                  linkUrl = dataHref;
                }
              }
              
              // Strategy 2: Look for direct article links if data-href didn't work
              if (!linkUrl) {
                const linkSelectors = [
                  'a[href*="medium.com"][href*="-"]', // Article URLs usually have dashes
                  'a[href*="/@"][href*="-"]',         // Author articles with dashes
                  'a[href*="medium.com"]',
                  'a[href*="/"]',
                  'a'
                ];

                                  for (const linkSel of linkSelectors) {
                    const linkElement = element.querySelector(linkSel);
                    if (linkElement && (linkElement as HTMLAnchorElement).href) {
                      let href = (linkElement as HTMLAnchorElement).href;
                      
                      // Clean up and validate the URL
                      if (href) {
                        // If it's a redirect URL, extract the actual article URL
                        if (href.includes('redirect=')) {
                          const redirectMatch = href.match(/redirect=([^&]+)/);
                          if (redirectMatch) {
                            href = decodeURIComponent(redirectMatch[1]);
                          }
                        }
                        
                        // Check if it's a valid article URL (prioritize actual articles)
                        const isValidArticleUrl = (
                          href.includes('medium.com') && 
                          !href.includes('/search?') &&  // Don't include search pages themselves
                          !href.includes('/signin') &&
                          !href.includes('/bookmark') &&
                          !href.includes('/signup') &&
                          // Prioritize URLs that look like actual articles
                          (href.includes('-') ||  // Article slugs usually have dashes
                           href.includes('/@') || 
                           href.match(/\/[a-f0-9]{8,}/))  // Article IDs (8+ chars)
                        );
                        
                        if (isValidArticleUrl) {
                          // Clean the URL but preserve the path
                          if (href.includes('?')) {
                            // Extract the actual article URL from redirect parameters
                            if (href.includes('redirect=')) {
                              const redirectMatch = href.match(/redirect=([^&]+)/);
                              if (redirectMatch) {
                                linkUrl = decodeURIComponent(redirectMatch[1]);
                              }
                            } else {
                              // Just remove query parameters for cleaner URLs
                              linkUrl = href.split('?')[0];
                            }
                          } else {
                            linkUrl = href;
                          }
                          break;
                        }
                      }
                    }
                  }
                }

              // Try to get author info
              const authorSelectors = [
                '[data-testid="story-author"]',
                '.postMetaInline-authorLockup',
                '.story-author',
                '.author-name'
              ];

              let authorText = '';
              for (const authorSel of authorSelectors) {
                const authorElement = element.querySelector(authorSel);
                if (authorElement && authorElement.textContent?.trim()) {
                  authorText = authorElement.textContent.trim();
                  break;
                }
              }

              // Try to get snippet/preview
              const snippetSelectors = [
                '.story-excerpt',
                '.post-excerpt',
                '.graf--p',
                'p'
              ];

              let snippetText = '';
              for (const snippetSel of snippetSelectors) {
                const snippetElement = element.querySelector(snippetSel);
                if (snippetElement && snippetElement.textContent?.trim()) {
                  snippetText = snippetElement.textContent.trim().substring(0, 200);
                  break;
                }
              }

              log(`📝 Article ${index + 1}:`, {
                title: titleText,
                url: linkUrl,
                author: authorText,
                snippet: snippetText.substring(0, 50) + '...'
              });

              if (titleText && linkUrl) {
                articles.push({
                  title: titleText,
                  content: snippetText,
                  url: linkUrl,
                  publishDate: '',
                  tags: [],
                  claps: 0
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
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
} 