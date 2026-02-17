// IMPORTANT! Set the runtime to edge
export const runtime = "edge";

import {
  convertToCoreMessages,
  experimental_createMCPClient,
  Message,
  streamText,
  tool,
} from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";

import { weatherTool } from "@/app/utils/tools";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Initialize the Google Generative AI API
 */
const google = createGoogleGenerativeAI();

// MCP client cache to avoid recreating on every request
let mcpClientsCache: {
  smartSearch: any;
  cloudinary: any;
  wordpress: any;
} | null = null;

const createPostDescription =
  "Create a WordPress post. If including a Cloudinary image, ALWAYS pass cloudinary_url (secure URL) so the image is embedded.";

const createPostParameters = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(["publish", "draft", "pending"]).optional(),
  cloudinary_url: z.string().optional(),
  cloudinary_public_id: z.string().optional(),
});
const updatePostParameters = z.object({
  post_id: z.number(),
  title: z.string().optional(),
  content: z.string().optional(),
  status: z.string().optional(),
});
const getPostParameters = z.object({
  post_id: z.number(),
});
const listPostsParameters = z.object({
  limit: z.number().optional(),
  status: z.string().optional(),
});
const passthroughObjectParameters = z.object({}).passthrough();

function validateCreatePostArgs(args: z.infer<typeof createPostParameters>) {
  if (args.cloudinary_public_id && !args.cloudinary_url) {
    throw new Error(
      "cloudinary_url is required to embed the image when cloudinary_public_id is provided."
    );
  }
}

function addHyphenAliases(tools: Record<string, any>, extraAliases: Record<string, string> = {}) {
  const withAliases: Record<string, any> = { ...tools };
  for (const [name, tool] of Object.entries(tools)) {
    const alias = name.replace(/-/g, "_");
    if (!(alias in withAliases)) {
      withAliases[alias] = tool;
    }
  }

  for (const [alias, canonicalName] of Object.entries(extraAliases)) {
    if (canonicalName in withAliases && !(alias in withAliases)) {
      withAliases[alias] = withAliases[canonicalName];
    }
  }

  return withAliases;
}

async function loadToolsSafely(
  client: any,
  builder: (rawTools: Record<string, any>) => Record<string, any>
) {
  if (!client) return {};

  try {
    const rawTools = await client.tools();
    return builder(rawTools);
  } catch {
    return {};
  }
}

function buildStableSmartSearchTools(rawTools: Record<string, any>) {
  const stableTools: Record<string, any> = {};

  if (rawTools.search?.execute) {
    stableTools.search = tool({
      description:
        rawTools.search.description ||
        "Search for relevant information and return ranked results.",
      parameters: z.object({
        query: z.string().min(1),
        filter: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }),
      execute: async (args) => rawTools.search.execute(args),
    });
  }

  if (rawTools.fetch?.execute) {
    stableTools.fetch = tool({
      description:
        rawTools.fetch.description ||
        "Fetch a document by ID and return its full content.",
      parameters: z.object({
        id: z.string().min(1),
      }),
      execute: async (args) => rawTools.fetch.execute(args),
    });
  }

  return stableTools;
}

function buildStableCloudinaryTools(rawTools: Record<string, any>) {
  const stableTools: Record<string, any> = {};
  const cloudinaryToolNames = [
    "search-assets",
    "list-images",
    "list-videos",
    "list-files",
    "get-asset-details",
    "list-tags",
    "visual-search-assets",
    "transform-asset",
    "get-tx-reference",
  ];

  for (const name of cloudinaryToolNames) {
    const raw = rawTools[name];
    if (!raw?.execute) continue;

    if (name === "search-assets") {
      stableTools[name] = tool({
        description:
          raw.description ||
          "Search Cloudinary assets. Supports plain query text and advanced request payload.",
        parameters: z.object({
          query: z.string().optional(),
          expression: z.string().optional(),
          max_results: z.number().optional(),
          next_cursor: z.string().optional(),
        }).passthrough(),
        execute: async (args) => {
          const expression = args.expression || args.query || "";
          return raw.execute({
            request: {
              expression,
              ...(args.max_results ? { max_results: args.max_results } : {}),
              ...(args.next_cursor ? { next_cursor: args.next_cursor } : {}),
            },
          });
        },
      });
      continue;
    }

    stableTools[name] = tool({
      description: raw.description || `Cloudinary tool: ${name}`,
      // Force OBJECT schema for Gemini compatibility.
      parameters: passthroughObjectParameters,
      execute: async (args) => raw.execute(args ?? {}),
    });
  }

  return stableTools;
}

function buildStableWordPressTools(rawTools: Record<string, any>) {
  const stableTools: Record<string, any> = {};
  const wordpressToolNames = [
    "wpengine--get-current-site-info",
    "wpengine--purge-cache",
    "wpengine--create-post",
    "wpengine--update-post",
    "wpengine--get-post",
    "wpengine--list-posts",
    "wpengine--index-cloudinary-asset",
    "wpengine--bulk-index-cloudinary-assets",
  ];

  for (const name of wordpressToolNames) {
    const raw = rawTools[name];
    if (!raw?.execute) continue;

    if (name === "wpengine--create-post") {
      stableTools[name] = tool({
        description: raw.description || createPostDescription,
        parameters: createPostParameters,
        execute: async (args) => {
          validateCreatePostArgs(args);
          return raw.execute(args);
        },
      });
      continue;
    }

    if (name === "wpengine--update-post") {
      stableTools[name] = tool({
        description: raw.description || "Update an existing WordPress post.",
        parameters: updatePostParameters,
        execute: async (args) => raw.execute(args),
      });
      continue;
    }

    if (name === "wpengine--get-post") {
      stableTools[name] = tool({
        description: raw.description || "Get details of a WordPress post by ID.",
        parameters: getPostParameters,
        execute: async (args) => raw.execute(args),
      });
      continue;
    }

    if (name === "wpengine--list-posts") {
      stableTools[name] = tool({
        description: raw.description || "List WordPress posts.",
        parameters: listPostsParameters,
        execute: async (args) => raw.execute(args ?? {}),
      });
      continue;
    }

    stableTools[name] = tool({
      description: raw.description || `WordPress tool: ${name}`,
      parameters: passthroughObjectParameters,
      execute: async (args) => raw.execute(args ?? {}),
    });
  }

  return stableTools;
}

function buildDirectWordPressFallbackTools(wordpressMcpUrl?: string, wordpressMcpToken?: string) {
  if (!wordpressMcpUrl || !wordpressMcpToken) {
    return {};
  }

  const callWordPressTool = async (name: string, args: Record<string, any>) => {
    const response = await fetch(wordpressMcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-mcp-token": wordpressMcpToken,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name,
          arguments: args ?? {},
        },
      }),
    });

    const rawText = await response.text();
    let payload: any;
    try {
      payload = JSON.parse(rawText);
    } catch {
      throw new Error(`WordPress MCP returned non-JSON response (status ${response.status})`);
    }

    if (!response.ok || payload?.error) {
      throw new Error(
        payload?.error?.message || `WordPress MCP request failed (status ${response.status})`
      );
    }

    return payload?.result ?? payload;
  };

  return {
    "wpengine--create-post": tool({
      description: createPostDescription,
      parameters: createPostParameters,
      execute: async (args) => {
        validateCreatePostArgs(args);
        return callWordPressTool("wpengine--create-post", args);
      },
    }),
    "wpengine--update-post": tool({
      description: "Update an existing WordPress post.",
      parameters: updatePostParameters,
      execute: async (args) => callWordPressTool("wpengine--update-post", args),
    }),
    "wpengine--get-post": tool({
      description: "Get details of a specific WordPress post.",
      parameters: getPostParameters,
      execute: async (args) => callWordPressTool("wpengine--get-post", args),
    }),
    "wpengine--list-posts": tool({
      description: "List WordPress posts.",
      parameters: listPostsParameters,
      execute: async (args) => callWordPressTool("wpengine--list-posts", args ?? {}),
    }),
    "wpengine--get-current-site-info": tool({
      description: "Get information about the current WordPress site.",
      parameters: passthroughObjectParameters,
      execute: async () => callWordPressTool("wpengine--get-current-site-info", {}),
    }),
  };
}

async function getMCPClients() {
  if (mcpClientsCache) {
    return mcpClientsCache;
  }

  // Smart Search MCP Client
  const smartSearchTransport = new StreamableHTTPClientTransport(
    new URL(process.env.AI_TOOLKIT_MCP_URL || "http://localhost:8080/mcp")
  );

  const smartSearchClient = await experimental_createMCPClient({
    transport: smartSearchTransport,
  });

  // Cloudinary MCP Client (Remote)
  const cloudinaryMcpUrl = process.env.CLOUDINARY_MCP_URL || "https://asset-management.mcp.cloudinary.com/sse";

  let cloudinaryClient = null;
  let wordpressClient = null;

  try {
    const cloudinaryTransport = new StreamableHTTPClientTransport(
      new URL(cloudinaryMcpUrl),
      {
        fetch: (url: string | URL, init?: RequestInit) => {
          const headers: Record<string, string> = {
            ...init?.headers as Record<string, string>,
            'Accept': 'application/json, text/event-stream',
            'Content-Type': 'application/json',
          };

          // Add Cloudinary credentials if provided
          if (process.env.CLOUDINARY_CLOUD_NAME) {
            headers['cloudinary-cloud-name'] = process.env.CLOUDINARY_CLOUD_NAME;
          }
          if (process.env.CLOUDINARY_API_KEY) {
            headers['cloudinary-api-key'] = process.env.CLOUDINARY_API_KEY;
          }
          if (process.env.CLOUDINARY_API_SECRET) {
            headers['cloudinary-api-secret'] = process.env.CLOUDINARY_API_SECRET;
          }

          return fetch(url, {
            ...init,
            headers
          });
        }
      } as any
    );

    cloudinaryClient = await experimental_createMCPClient({
      transport: cloudinaryTransport,
    });
  } catch {
    cloudinaryClient = null;
  }

  const wordpressMcpUrl = process.env.WORDPRESS_MCP_URL;
  const wordpressMcpToken = process.env.WORDPRESS_MCP_TOKEN;
  if (wordpressMcpUrl && wordpressMcpToken) {
    try {
      const wordpressTransport = new StreamableHTTPClientTransport(
        new URL(wordpressMcpUrl),
        {
          fetch: (url: string | URL, init?: RequestInit) => {
            const headers: Record<string, string> = {
              ...(init?.headers as Record<string, string>),
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
              "x-mcp-token": wordpressMcpToken,
            };

            return fetch(url, {
              ...init,
              headers,
            });
          },
        } as any
      );

      wordpressClient = await experimental_createMCPClient({
        transport: wordpressTransport,
      });
    } catch {
      wordpressClient = null;
    }
  }

  mcpClientsCache = {
    smartSearch: smartSearchClient,
    cloudinary: cloudinaryClient,
    wordpress: wordpressClient,
  };

  return mcpClientsCache;
}

export async function POST(req: Request) {
  try {
    // Get MCP clients
    const {
      smartSearch: smartSearchClient,
      cloudinary: cloudinaryClient,
      wordpress: wordpressClient,
    } = await getMCPClients();

    // Get tools from Smart Search MCP
    const rawSmartSearchTools = await smartSearchClient.tools();
    const smartSearchTools = buildStableSmartSearchTools(rawSmartSearchTools);

    // Get tools from Cloudinary MCP if connected
    const cloudinaryTools = await loadToolsSafely(
      cloudinaryClient,
      buildStableCloudinaryTools
    );

    // Get tools from WordPress MCP if connected
    let wordpressTools = await loadToolsSafely(
      wordpressClient,
      buildStableWordPressTools
    );
    if (Object.keys(wordpressTools).length === 0) {
      wordpressTools = buildDirectWordPressFallbackTools(
        process.env.WORDPRESS_MCP_URL,
        process.env.WORDPRESS_MCP_TOKEN
      );
    }

    const { messages }: { messages: Array<Message> } = await req.json();
    const coreMessages = convertToCoreMessages(messages);

    const systemPromptContent = `You are a helpful AI assistant with access to tools for searching data.

CRITICAL INSTRUCTIONS:
1. When users ask about Cloudinary, images, videos, media, or assets:
   - You MUST use Cloudinary tools (search-assets, list-images, list-videos, etc.)
   - NEVER respond without calling a Cloudinary tool first
   - Example queries: "show images", "find assets", "list videos", "search for tag"

2. When users ask about TV shows or knowledge retrieval:
   - You MUST use the 'search' tool
   - NEVER respond without calling the search tool first

3. When users ask about WordPress posts, publishing, drafts, site info, or cache:
   - You MUST use WordPress tools (wpengine--create-post, wpengine--list-posts, etc.)
   - NEVER respond without calling a WordPress tool first
   - If creating a post with a Cloudinary image, you MUST include cloudinary_url in wpengine--create-post arguments

4. When users ask about weather:
   - You MUST use the weatherTool

NEVER make up data. ALWAYS call the appropriate tool before responding.`;

    const cloudinaryToolsWithAliases = addHyphenAliases(cloudinaryTools);
    const wordpressToolsWithAliases = addHyphenAliases(wordpressTools, {
      post: "wpengine--create-post",
    });

    const allTools = {
      ...cloudinaryToolsWithAliases,
      ...wordpressToolsWithAliases,
      ...smartSearchTools,
      weatherTool,
    };
    const response = streamText({
      model: google("models/gemini-2.0-flash", {
        useSearchGrounding: false,
      }),
      system: systemPromptContent,
      messages: coreMessages,
      tools: allTools,
      maxSteps: 5,
    });

    // Convert the response into a friendly text-stream
    return response.toDataStreamResponse({
      getErrorMessage: (error) => {
        const message =
          error instanceof Error ? error.message : "Unknown streaming error";
        console.error("[streamText error]", error);
        return `Stream error: ${message}`;
      },
    });
  } catch (e) {
    console.error('[API Error]', e);
    throw e;
  }
}
