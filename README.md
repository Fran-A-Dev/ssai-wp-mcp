# Smart Search + Cloudinary + WordPress MCP Chatbot

This project is a Next.js chatbot that uses MCP tools for:
- WP Engine Smart Search AI (`search`, `fetch`)
- Cloudinary asset management tools
- WordPress content tools (create/list/update/get posts, site info, cache purge)

It is based on the WP Engine Smart Search RAG chatbot example and extended with Cloudinary + WordPress MCP integration.

## Prerequisites

- Node.js 18+ (or newer)
- npm
- Access to:
  - Google Gemini API key
  - Smart Search MCP endpoint
  - Cloudinary credentials
  - A WordPress site with the WP MCP plugin installed

## Required WordPress Plugin

Install this plugin on your WordPress site (the chatbot expects this endpoint/tool shape):

- `https://github.com/Fran-A-Dev/wpe-ssai-cloudinary-mcp`

After activation, copy:
- MCP endpoint: `https://your-site.com/wp-json/wpengine/v1/mcp`
- MCP token from WP Admin settings page

## Environment Variables

Create your local env file from the sample:

```bash
cp .env.local.sample .env.local
```

Set the following values in `.env.local`:

```env
# Smart Search AI MCP
AI_TOOLKIT_MCP_URL=

# Google AI (Gemini) API Key
GOOGLE_GENERATIVE_AI_API_KEY=

# Cloudinary MCP Configuration
CLOUDINARY_MCP_URL=

# Cloudinary Account Credentials
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# WordPress MCP Configuration
# Plugin endpoint example: https://your-site.com/wp-json/wpengine/v1/mcp
WORDPRESS_MCP_URL=
# Token from WP Admin -> Settings -> WP Engine MCP
WORDPRESS_MCP_TOKEN=
```

## Run Locally

Install dependencies:

```bash
npm install
```

Start dev server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Production Check

Before deploying/publishing:

```bash
npm run lint
npm run build
```

## References

- WP Engine Smart Search: `https://wpengine.com/smart-search/`
- WP Engine Smart Search docs: `https://developers.wpengine.com/docs/wp-engine-smart-search/overview/`
