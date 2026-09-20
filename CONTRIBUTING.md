# Contributing to Medium MCP Server

Thank you for your interest in contributing to Medium MCP Server! This project helps developers interact with Medium through browser automation since Medium's API is no longer available for new users.

## 🤝 How to Contribute

### Reporting Issues
- **Bug Reports**: Use GitHub Issues with detailed reproduction steps
- **Feature Requests**: Describe the use case and expected behavior
- **Questions**: Check existing issues first, then open a new discussion

### Development Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/jackyckma/medium-mcp-server.git
   cd medium-mcp-server
   ```

2. **Install Dependencies**
   ```bash
   npm install
   npx playwright install chromium
   ```

3. **Build and Test**
   ```bash
   npm run build
   node --test tests/browser-client.test.cjs
   ```

### Code Contributions

#### Before You Start
- Check existing issues and PRs to avoid duplication
- For major changes, open an issue first to discuss the approach
- Follow the existing code style and patterns

#### Development Guidelines

**Browser Automation (Playwright)**
- Use robust selectors that won't break with minor UI changes
- Add fallback selectors for critical functionality
- Test with both headless and headed modes
- Handle timeouts gracefully

**TypeScript Standards**
- Use strict TypeScript configuration
- Add proper type definitions for all functions
- Document complex logic with comments
- Follow existing naming conventions

**Error Handling**
- Provide meaningful error messages
- Handle Medium's rate limiting gracefully
- Log errors appropriately (use `console.error` for MCP compatibility)
- Add retry logic for transient failures

#### Testing

After `npm run build`, run `node --test tests/browser-client.test.cjs` for the behavioral checks using doubles. For controlled pages in a real browser, follow [the Chromium validation record](tests/CHROMIUM-VALIDATION.md), which owns the browser prerequisites, command and remote-validation limitations.

Run `python3 scripts/test-mcp-launch.py` to check the launcher with the installed `/usr/bin/xvfb-run` and its Xvfb prerequisites. No formatter or linter is configured in this repository; `./node_modules/.bin/tsc --noEmit` performs the configured TypeScript static analysis without emitting build files.

- Test remote behavior only with authorized Medium access
- Verify session persistence works correctly
- Test both login and non-login scenarios
- Check that MCP tools return proper JSON responses

#### Code Style
- Use TypeScript with strict mode
- 2-space indentation
- Semicolons required
- Use async/await over Promises
- Descriptive variable and function names

### Pull Request Process

1. **Create Feature Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Changes**
   - Write clean, well-documented code
   - Add/update tests as needed
   - Update README if adding new features

3. **Test Thoroughly**
   ```bash
   npm run build
   # Test your changes with actual Medium interactions
   # Verify MCP integration works in Claude
   ```

4. **Commit with Clear Messages**
   ```bash
   git commit -m "feat: add article tagging support"
   git commit -m "fix: handle Medium login timeout gracefully"
   git commit -m "docs: update installation instructions"
   ```

5. **Push and Create PR**
   ```bash
   git push origin feature/your-feature-name
   ```
   - Use the GitHub PR template
   - Describe what you changed and why
   - Include screenshots for UI-related changes
   - Reference any related issues

### Common Contribution Areas

**High Impact Contributions**
- **Selector Updates**: When Medium changes their UI
- **Error Handling**: Better error messages and recovery
- **Performance**: Faster browser automation
- **Documentation**: Clearer setup and troubleshooting guides

**Feature Ideas**
- Support for Medium publications
- Article drafts management
- Better session management
- Article analytics retrieval
- Bulk operations

### Medium-Specific Considerations

**Browser Automation Challenges**
- Medium frequently updates their UI selectors
- Anti-automation detection requires careful handling
- Session management across different login methods
- Rate limiting and respectful usage

**Testing with Medium**
- Use a test Medium account for development
- Be respectful of Medium's servers during testing
- Don't spam or create excessive test content
- Test with different article types and lengths

### Code Review Process

**What We Look For**
- ✅ Code works with current Medium website
- ✅ Proper error handling and logging
- ✅ TypeScript types are correct
- ✅ No breaking changes to existing MCP tools
- ✅ Documentation is updated
- ✅ Follows project conventions

**Review Timeline**
- Initial response: 1-3 days
- Full review: 1-2 weeks
- Complex features may take longer

### Getting Help

**Stuck on Something?**
- Check the troubleshooting section in README
- Look at existing code for patterns
- Open a draft PR with questions
- Ask in GitHub Discussions

**Communication**
- Be respectful and constructive
- Provide context and examples
- Share error logs and reproduction steps
- Be patient with review feedback

## 🏗️ Project Architecture

### Key Components
- **`browser-client.ts`**: Core Playwright automation
- **`index.ts`**: MCP server implementation
- **Session Management**: Login persistence and validation
- **Selectors**: CSS selectors for Medium's UI elements

### Adding New Features
1. **MCP Tool**: Add to `index.ts` with proper schema
2. **Browser Logic**: Implement in `browser-client.ts`
3. **Error Handling**: Add appropriate error cases
4. **Documentation**: Update README with new tool info

## 📋 Checklist for Contributors

**Before Submitting PR**
- [ ] Code builds without errors (`npm run build`)
- [ ] Browser automation works in both headless and headed mode
- [ ] MCP tools return proper JSON responses
- [ ] Error handling is comprehensive
- [ ] Documentation is updated
- [ ] No sensitive data (API keys, sessions) in code
- [ ] Follows existing code patterns
- [ ] Git history is clean

**PR Description Should Include**
- [ ] What changes were made
- [ ] Why the changes were necessary
- [ ] How to test the changes
- [ ] Any breaking changes
- [ ] Screenshots (if UI-related)

## 🚀 Release Process

**Versioning**
- Follow semantic versioning (semver)
- Major: Breaking changes to MCP tools
- Minor: New features, new MCP tools
- Patch: Bug fixes, selector updates

**Release Notes**
- Highlight new features and fixes
- Include migration notes for breaking changes
- Credit contributors

---

**Thank you for contributing to Medium MCP Server!** 

Your contributions help make AI-powered content publishing more accessible to developers worldwide.

**Questions?** Open an issue or start a discussion on GitHub. 