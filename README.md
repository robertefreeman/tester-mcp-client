# Tester Client for Model Context Protocol (MCP)

[![Actors MCP Client](https://apify.com/actor-badge?actor=jiri.spilka/tester-mcp-client)](https://apify.com/jiri.spilka/tester-mcp-client)

Implementation of a model context protocol (MCP) client that connects to an MCP server using Server-Sent Events (SSE) and displays the conversation in a chat-like UI.
It is a standalone Actor server designed for testing MCP servers over SSE.

## 🚀 Main features

- 🔌 Connects to an MCP server using Server-Sent Events (SSE)
- 💬 Provides a chat-like UI for displaying tool calls and results
- 🇦 Connects to an [Apify MCP Server](https://apify.com/apify/actors-mcp-server) for interacting with one or more Apify Actors
- 💥 Dynamically loads and utilizes tools based on context and user queries (only if supported by the server)
- 🔓 Use Authorization headers and API keys for secure connections
- 🪟 Open source, so you can review it, suggest improvements, or modify it

# 🎯 What does Tester MCP Client do?

The Apify MCP Client connects to a running MCP server over Server-Sent Events (SSE) and it does the following:

- Initiates an SSE connection to the MCP server `/sse`.
- Sends user queries to the MCP server via `POST /message`.
- Receives real-time streamed responses (via `GET /sse`) that may include LLM output, and **tool usage** blocks
- Based on the LLM response, orchestrates tool calls and displays the conversation
- Displays the conversation


## How it works

```plaintext
Browser ← (SSE) → Tester MCP Clinent  ← (SSE) → MCP Server
```
We create this chain to keep any custom bridging logic inside the Tester MCP Client, while leaving the main MCP Server unchanged.
The browser uses SSE to communicate with the Tester MCP Client, and the Tester MCP Client relies on SSE to talk to the MCP Server.
This separates extra client-side logic from the core server, making it easier to maintain and debug.

1. Navigate to `https://tester-mcp-client.apify.actor?token=YOUR-API-TOKEN` (or http://localhost:3000 if you are running it locally).
2. Files `index.html` and `client.js` are served from the `public/` directory.
3. Browser opens SSE stream via `GET /sse`.
4. The user’s query is sent with `POST /message`.
5. Query processing:
    - Calls Large Language Model.
    - Optionally calls tools if required using
6. For each result chunk, `sseEmit(role, content)`

# ⚙️ Usage

Once you have the Tester MCP Client running, you can ask:
- "What Apify Actors I can use"
- "Which Actor is the best for scraping Instagram comments"
- "Can you scrape the first 10 pages of Google search results for 'best restaurants in Prague'?"

## Standby Mode (on Apify)

- Test any MCP server over SSE with a standalone client running on Apify
- Test [Apify Actors MCP Server](https://apify.com/apify/actors-mcp-server) and ability to dynamically select amongst 3000+ tools
- Request data from a remote Apify Actor (e.g., [Google Maps with contact details](https://apify.com/lukaskrivka/google-maps-with-contact-details)).

### Pricing

The Apify MCP Client is free to use. You only pay for the resources you consume on the Apify platform.

Running the MCP Client for 1 hour costs approximately $0.06.
With the Apify Free tier (no credit card required 💳), you can run the MCP Client for 80 hours per month.
Definitely enough to test your MCP server!

## Local Development

The Tester MCP Client Actor has open source available on [GitHub](https://github.com/apify/rag-web-browser), so that you can modify and develop it yourself.

Download the source code:

```bash
git clone https://github.com/apify/tester-mcp-client.git
cd tester-mcp-client
```
Server will start on `http://localhost:3000` and you can send requests to it, for example:

```bash
curl "http://localhost:3000/search?query=example.com"
```

You can deploy the MCP client as a **standalone Apify Actor** that serves:

- `index.html` + `client.js` for a chat UI.
- On load, the UI connects via SSE to your **main MCP server** (either local or on Apify).

**Or** you can run the client locally for development:

1. Serve the `index.html` + `client.js` from an Express server (e.g., `app.use(express.static('public'))`).
2. In `client.js`, set `new EventSource('https://path-to-your-mcp-server/sse')`.
3. Start interacting with the server.


- **System Prompt**: If you have a system prompt or instructions to show the user, fetch or define them in your code. Display them in a collapsible `<details>` block.


# ⓘ Limitations and feedback

The client does not support all MCP features, such as Prompts and Resource.
Also, it does not store the conversation on the client side.

**Happy chatting with Apify Actors!**
