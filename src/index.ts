import { config } from 'dotenv';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserMediumClient } from './browser-client';

// Load environment variables
config();

class MediumMcpServer {
  private server: McpServer;
  private mediumClient: BrowserMediumClient;

  constructor() {
    // Initialize browser-based Medium client
    this.mediumClient = new BrowserMediumClient();

    // Create MCP server instance
    this.server = new McpServer({
      name: "medium-mcp-server",
      version: "2.0.0"
    });

    this.registerTools();
  }

  private registerTools() {
    // Tool for publishing articles (now browser-based)
    this.server.tool(
      "publish-article",
      "Publish a new article on Medium using browser automation. On the first use (no saved session) a one-time login window may open; after that the session is reused silently in the background.",
      {
        title: z.string().min(1, "Title is required"),
        content: z.string().min(10, "Content must be at least 10 characters"),
        tags: z.array(z.string()).optional(),
        isDraft: z.boolean().optional().default(false)
      },
      async (args) => {
        try {
          const publishResult = await this.mediumClient.publishArticle({
            title: args.title,
            content: args.content,
            tags: args.tags,
            isDraft: args.isDraft
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(publishResult, null, 2)
              }
            ]
          };
        } catch (error: any) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error publishing article: ${error.message}`
              }
            ]
          };
        }
      }
    );

    // Tool for retrieving user's published articles
    this.server.tool(
      "get-my-articles",
      "Retrieve your published Medium articles. On the first use (no saved session) a one-time login window may open; after that the session is reused silently in the background.",
      {},
      async () => {
        try {
          const articles = await this.mediumClient.getUserArticles();

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(articles, null, 2)
              }
            ]
          };
        } catch (error: any) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error retrieving articles: ${error.message}`
              }
            ]
          };
        }
      }
    );

    // Tool for getting full content of a specific article
    this.server.tool(
      "get-article-content",
      "Get the full content of a Medium article by URL. When requireLogin is true and there is no saved session, a one-time login window may open on first use; after that the session is reused silently in the background.",
      {
        url: z.string().url("Must be a valid URL"),
        requireLogin: z.boolean().optional().default(true).describe("If true, ensures you are logged in (may open a one-time login window on first use) to access full/member-only content. Set false for preview-only content without login.")
      },
      async (args) => {
        try {
          const content = await this.mediumClient.getArticleContent(args.url, args.requireLogin);

          return {
            content: [
              {
                type: "text",
                text: content
              }
            ]
          };
        } catch (error: any) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error retrieving article content: ${error.message}`
              }
            ]
          };
        }
      }
    );

    // Tool for searching Medium articles
    this.server.tool(
      "search-medium",
      "Search Medium for articles by keywords",
      {
        keywords: z.array(z.string()).min(1, "At least one keyword is required")
      },
      async (args) => {
        try {
          const articles = await this.mediumClient.searchMediumArticles(args.keywords);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(articles, null, 2)
              }
            ]
          };
        } catch (error: any) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error searching articles: ${error.message}`
              }
            ]
          };
        }
      }
    );

    // Tool to manually trigger login (useful for initial setup)
    this.server.tool(
      "login-to-medium",
      "Manually trigger Medium login process",
      {},
      async () => {
        try {
          const success = await this.mediumClient.ensureLoggedIn();
          
          return {
            content: [
              {
                type: "text",
                text: success ? "✅ Successfully logged in to Medium" : "❌ Login failed"
              }
            ]
          };
        } catch (error: any) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Login error: ${error.message}`
              }
            ]
          };
        }
      }
    );
  }

  // Method to start the server
  async start() {
    try {
      // Browser is launched lazily (headless) on first tool use — no window
      // appears at startup. A visible window only opens for one-time login.
      await this.mediumClient.initialize();
      console.error("🌐 Browser Medium client ready (lazy, headless)");

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("🚀 Medium MCP Server (Browser-based) Initialized");
    } catch (error) {
      console.error("Failed to start server:", error);
      throw error;
    }
  }

  // Cleanup method
  async cleanup() {
    await this.mediumClient.close();
  }
}

// Main execution
async function main() {
  const server = new MediumMcpServer();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.error("🛑 Shutting down Medium MCP Server...");
    await server.cleanup();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.error("🛑 Shutting down Medium MCP Server...");
    await server.cleanup();
    process.exit(0);
  });

  await server.start();
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
