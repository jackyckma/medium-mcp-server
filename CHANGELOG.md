# Changelog

All notable changes to Medium MCP Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-07-08

### 🎉 Initial Release

**Major Achievement**: Complete rewrite from API-based to browser automation approach due to Medium's API deprecation.

### Added
- **Browser-based automation** using Playwright instead of deprecated Medium API
- **MCP Tools**:
  - `publish-article` - Publish articles with title, content, tags, and draft option
  - `get-my-articles` - Retrieve user's published articles
  - `search-medium` - Search Medium articles by keywords
  - `get-article-content` - Extract full content from any Medium article
  - `login-to-medium` - Manual login trigger for session management

### Features
- **Session persistence** - See [Session Management](README.md#session-management) for scope and reuse
- **Browser mode** - See [Configuration](README.md#configuration) for current behavior
- **Anti-detection measures** - Realistic browser automation to avoid blocking
- **Multiple login methods** - Support for email/password and Google login
- **Robust content extraction** - Handles both preview and full article content
- **Enhanced search** - Returns actual article URLs with proper content extraction
- **Error handling** - Comprehensive error messages and recovery strategies

### Technical Implementation
- **TypeScript** with strict mode configuration
- **Playwright** browser automation with Chromium
- **MCP SDK** integration for Claude compatibility
- **Zod** schema validation for type safety
- **Session management** with automatic validation and renewal

### Browser Automation Features
- **Smart selectors** with fallback strategies for UI changes
- **Rate limiting** respect for Medium's servers
- **Timeout handling** for reliable automation
- **Preview detection** for content extraction
- **URL validation** to ensure proper article links

### Documentation
- Comprehensive README with setup instructions
- Troubleshooting guide for common issues
- Contributing guidelines for developers
- Example configurations for Claude integration

### Development Tools
- Multiple test scripts for validation
- Debug utilities for selector updates
- Session management helpers
- Login flow debugging tools

## [0.x.x] - Legacy API Version

### Deprecated
- **Medium API integration** - No longer functional due to Medium's API discontinuation
- **OAuth2 flow** - Replaced with browser-based session management
- **API token authentication** - Not available for new users

---

## Future Roadmap

### Planned Features
- **Publication support** - Publish to Medium publications
- **Article analytics** - Retrieve article performance data
- **Bulk operations** - Mass article management
- **Enhanced tagging** - Better tag management and suggestions
- **Draft management** - Advanced draft handling and scheduling

### Technical Improvements
- **Performance optimization** - Faster browser automation
- **Selector resilience** - Better handling of Medium UI changes
- **Session security** - Enhanced session encryption and management
- **Error recovery** - More robust error handling and retry logic

---

## Migration Guide

### From API Version (0.x.x) to Browser Version (1.0.0)

**Breaking Changes**:
- No more API tokens required
- New authentication flow via browser login
- Different response formats for some tools
- Session management replaces token-based auth

**Migration Steps**:
1. Remove old `.env` API configurations
2. Install Playwright: `npx playwright install chromium`
3. Update Claude MCP configuration
4. Follow [First Time Setup](README.md#first-time-setup) for browser login
5. Test functionality with new browser-based tools

**Benefits of Migration**:
- ✅ No API token limitations
- ✅ Access to full Medium functionality
- ✅ Better content extraction capabilities
- ✅ Support for all Medium features

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to contribute to this project.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. 