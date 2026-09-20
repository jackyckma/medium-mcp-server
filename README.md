# <img src="https://cdn-static-1.medium.com/_/fp/icons/Medium-Avatar-500x500.svg" alt="Medium Logo" width="32" height="32"> Medium MCP Server (Browser-Based)

## Overview
Medium MCP (Model Context Protocol) is a browser-based solution for programmatically interacting with Medium's content ecosystem. Since Medium discontinued their public API for new users, this server uses browser automation to provide intelligent and context-aware content management.

## 🔄 Why Browser-Based?
Medium stopped issuing new API tokens in 2023, making traditional API integration impossible for new developers. This implementation uses Playwright browser automation to:
- ✅ **Work without API tokens** - Uses your existing Medium login session
- ✅ **Full functionality** - Publish, search, and manage your Medium content
- ✅ **Secure** - Saves your login session locally for reuse
- ✅ **Browser mode** - See [Configuration](#configuration) for display and login settings

## 📖 Deep Dive Article
Want to understand the full story behind Medium MCP? Check out the comprehensive article:

[From Thought to Published: How MediumMCP Streamlines the AI-to-Medium Platform Workflow](https://dishantragav27.medium.com/from-thought-to-published-how-mediummcp-streamlines-the-ai-to-medium-platform-workflow-9e436159d1a2)

## Key Features
- 🤖 **Browser automation** for Medium interaction
- 📝 **Article publishing** with title, content, and tags
- 📚 **Retrieve your articles** from your Medium profile
- 🔍 **Search Medium articles** by keywords
- 💾 **Session persistence** - See [Session Management](#session-management)
- 🎯 **Claude integration** via Model Context Protocol

## Technology Stack
- TypeScript
- Model Context Protocol (MCP)
- Playwright Browser Automation
- Advanced Content Parsing

## Getting Started

### Prerequisites
- Node.js (v16 or later)
- npm or yarn
- A Medium account for account-specific operations; public search and reading can run anonymously

### Installation
```bash
# Clone the repository
git clone https://github.com/jackyckma/medium-mcp-server.git

# Navigate to the project directory
cd medium-mcp-server

# Install dependencies
npm install

# Install browser for automation
npx playwright install chromium

# Build the project
npm run build
```

### Configuration
No API keys are needed. Optional browser settings are loaded from the process environment or `.env` in the working directory before browser configuration is evaluated. See [.env.example](.env.example) for a copyable example; restart the server after changing settings.

`MEDIUM_HEADLESS` enables operation without a display only when set to `1` or `true`. Otherwise Chromium uses a display. Manual login requires an accessible browser window; without a display, an unsuccessful login check returns failure and public article reading can still proceed.

`MEDIUM_MAX_CONTENT_LENGTH` limits extracted text on both the main and fallback paths. Its default is 50000 JavaScript string units; invalid, nonpositive or unsafe integer values use that default. Longer results include a `[TRUNCATED: ...]` notice after the retained text. Increase the setting and restart to retrieve more.

### Usage

#### Test the Browser Client
See [Testing](CONTRIBUTING.md#testing) for the maintained checks and their prerequisites.

#### Start the MCP Server
```bash
npm start
```

The server connects MCP before launching Chromium. The first tool invocation starts the browser, and concurrent initialization requests share that startup. Protocol messages use standard output; diagnostics use standard error. Closing the client's input stream or sending a shutdown signal triggers browser cleanup.

On Linux with `/usr/bin/xvfb-run` and its Xvfb prerequisites already installed, use the launcher when a virtual display is needed:

```sh
./scripts/mcp-launch.sh node dist/index.js
```

The launcher forwards its command and arguments while keeping the child process's diagnostics on standard error. A virtual display alone does not provide an interactive login window. For MCP integration, set `command` to the launcher's absolute path and pass the Node executable and server entry point in `args`.

#### Add to Claude Configuration
Add this to your Claude MCP configuration:
```json
{
  "mcpServers": {
    "medium-mcp": {
      "command": "node",
      "args": ["path/to/medium-mcp-server/dist/index.js"],
      "cwd": "path/to/medium-mcp-server"
    }
  }
}
```

## Available MCP Tools

### 1. `publish-article`
Publish a new article to Medium
```typescript
{
  title: string,      // Article title
  content: string,    // Article content (markdown supported)
  tags?: string[],    // Optional tags
  isDraft?: boolean   // Save as draft (default: false)
}
```

### 2. `get-my-articles`
Retrieve your published Medium articles
```typescript
// No parameters needed
// Returns: Array of your articles with titles, URLs, and dates
```

### 3. `get-article-content`
Read the content available to the current browser session. The supplied URL must use HTTPS on `medium.com` or one of its subdomains; custom publication domains are not accepted. Subscription restrictions and access challenges can still prevent full extraction.

The optional `requireLogin` argument defaults to `true` and requests a login attempt, not mandatory authentication. If login fails or is unavailable, reading continues anonymously. Set it to `false` to skip the attempt; an already loaded session remains available. For example:

```json
{"url": "https://medium.com/@author/article-id", "requireLogin": false}
```

See [Configuration](#configuration) for the extraction limit and truncation notice. The authoritative input schemas are registered in [src/index.ts](src/index.ts) and exposed through MCP `tools/list`.

### 4. `search-medium`
Search Medium for articles by keywords
```typescript
{
  keywords: string[]  // Array of search terms
}
```

Search results contain excerpts in `content`, not full article bodies. Valid Medium destinations embedded in login links are decoded; rejected candidates allow later extraction strategies to run. Unknown applause counts are returned as `claps: null`, not inferred from other numbers on the page.

### 5. `login-to-medium`
Manually trigger login process
```typescript
// No parameters needed
// Opens browser for login if not already authenticated
```

## How It Works

### First Time Setup
Start the server and invoke a tool to start Chromium. For account access, call `login-to-medium` and complete the browser login dialog if needed. Public search does not request login. See [Configuration](#configuration) for browser mode and [Session Management](#session-management) for reuse.

### Browser Automation Flow
```
User Request → MCP Server → Playwright Browser → Medium Website → Response
```

### Session Management
The server loads `medium-session.json` from its working directory. After observing a successful login, it saves browser storage there with owner-only file permissions (`0600`). This JSON is not encrypted. Keep it private and use a stable working directory to reuse the same session.

An existing file alone does not prove authentication. Login checks look for account-specific page elements; an expired or unreadable session can require login again. There is no global session directory or migration. Public operations remain available without creating a session.

## Example Usage with Claude

```
User: "Publish an article titled 'AI in 2025' with content about recent developments"

Claude: Uses publish-article tool →
- Opens Medium editor
- Fills in title and content
- Publishes article
- Returns success with article URL
```

## Troubleshooting

### Browser Issues
- **Browser won't open**: Check if Chromium is installed (`npx playwright install chromium`)
- **Login fails**: Clear `medium-session.json` and try again
- **Slow performance**: Browser automation takes 10-30 seconds per operation

### Medium Changes
- **Selectors outdated**: Medium occasionally changes their website structure
- **Login blocked**: Follow [First Time Setup](#first-time-setup) in the server-managed browser; a separate browser profile does not supply its session

### Common Errors
- `Browser not initialized`: Restart the server
- `Login timeout`: Increase timeout in browser-client.ts
- `Element not found`: Medium may have changed their UI

## Development

### Project Structure
```
src/
├── index.ts           # Main MCP server
└── browser-client.ts  # Playwright automation
```

### Testing
See [CONTRIBUTING.md](CONTRIBUTING.md#testing) for commands and [the Chromium validation record](tests/CHROMIUM-VALIDATION.md) for the evidence and remaining remote-validation limits of this repair.

## Security Notes
- Browser operations send requests to Medium.
- See [Session Management](#session-management) for storage location, permissions and protection requirements.
- No Medium API credentials are used.

## Limitations
- **Speed**: Browser automation is slower than API calls (10-30s vs 1-2s)
- **Reliability**: Dependent on Medium's website structure
- **Browser mode and login**: See [Configuration](#configuration)
- **Rate limits**: Subject to Medium's normal usage limits

## Contributing
Contributions welcome! Please read CONTRIBUTING.md for guidelines.

## License
MIT License - see LICENSE file for details.

## Support
- 🐛 **Issues**: GitHub Issues
- 💬 **Discussions**: GitHub Discussions
- 📧 **Email**: [Contact Author]

## 🤖 CREDIT and DISCLAIMER

### AI-Powered Development
This entire Medium MCP Server was **developed by AI (Claude/Cursor AI) in just a few hours**, demonstrating the remarkable power of AI-assisted development. The complete rewrite from deprecated API to browser automation, including all TypeScript code, documentation, error handling, and testing strategies, was generated through AI collaboration.

### What This Demonstrates
- ✅ **AI-First Development**: Complex browser automation and MCP integration built rapidly
- ✅ **Real-world Problem Solving**: Adapted to Medium's API deprecation with working solution
- ✅ **Production-Ready Code**: TypeScript, error handling, session management, comprehensive docs
- ✅ **Community Standards**: Contributing guidelines, changelog, proper licensing

### Current Status & Limitations
- **Validation scope**: See [the Chromium validation record](tests/CHROMIUM-VALIDATION.md) for verified behavior and external limitations
- ⚠️ **Google Login Sessions**: Couldn't solve persistent Google login sessions (use email/password instead)
- ⚠️ **Short Development Time**: Rapid development may have overlooked edge cases
- ⚠️ **Medium UI Changes**: Selectors may break if Medium updates their interface

### Honest Assessment
This tool is **useful and functional** for AI-powered content workflows, but comes with the inherent limitations of:
- **Rapid AI development** - may miss nuanced edge cases that human developers would catch
- **Browser automation complexity** - dependent on Medium's website structure
- **Session management challenges** - Google's anti-automation measures

### Feedback Welcome
Given the accelerated AI development process, **I welcome any feedback, bug reports, or improvements**. This serves as both a working tool and a demonstration of AI development capabilities and limitations.

**Use at your own discretion** - this is provided "as-is" with the understanding that rapid AI development, while powerful, may not cover all production scenarios.

---

**Note**: This is an unofficial tool and is not affiliated with Medium. Use responsibly and in accordance with Medium's Terms of Service.
