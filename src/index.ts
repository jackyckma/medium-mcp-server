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
      "Publish a new article on Medium using browser automation",
      {
        title: z.string().min(1, "Title is required"),
        content: z.string().min(10, "Content must be at least 10 characters"),
        tags: z.array(z.string()).optional(),
        isDraft: z.boolean().optional().default(false)
      },
      async (args) => {
        try {
          await this.ensureBrowser();
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
      "Retrieve your published Medium articles",
      {},
      async () => {
        try {
          await this.ensureBrowser();
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
      "Get the full content of a Medium article by URL",
      {
        url: z.string().url("Must be a valid URL"),
        requireLogin: z.boolean().optional().default(true).describe("Whether to attempt login for full content access")
      },
      async (args) => {
        try {
          await this.ensureBrowser();
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
          await this.ensureBrowser();
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
          await this.ensureBrowser();
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

  private async ensureBrowser(): Promise<void> {
    await this.mediumClient.initialize();
  }

  async start() {
    try {
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
  
  // Handle graceful shutdown.
  //
  // Le transport MCP est du stdio : quand le client disparaît, il ne signale
  // rien — il ferme simplement le pipe. Sans garde sur EOF, ce serveur et son
  // navigateur Playwright sous Xvfb survivaient indéfiniment. Constaté le
  // 2026-08-28 : 324 chrome, 37 Xvfb et 58 processus node orphelins, dont
  // certains vieux de 3 jours, saturant dbus (max_connections_per_user=256)
  // au point de rendre systemctl inutilisable.
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`🛑 Shutting down Medium MCP Server (${reason})...`);
    try {
      await server.cleanup();
    } catch (e) {
      console.error("cleanup failed:", e);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGHUP', () => { void shutdown('SIGHUP'); });

  // Le client MCP a fermé le pipe : plus personne n'écoute, on ferme le
  // navigateur au lieu de le laisser orphelin.
  process.stdin.on('end', () => { void shutdown('stdin end'); });
  process.stdin.on('close', () => { void shutdown('stdin close'); });
  process.stdin.on('error', () => { void shutdown('stdin error'); });

  await server.start();
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
