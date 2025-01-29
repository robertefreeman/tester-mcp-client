/**
 * # Chatbot Server with Real-Time Tool Execution
 *
 * Server for a chatbot integrated with Apify Actors and an MCP client.
 * Processes user queries, invokes tools dynamically, and streams real-time updates using Server-Sent Events (SSE)
 *
 * Environment variables:
 * - `APIFY_TOKEN` - API token for Apify (when using actors-mcp-server)
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { Actor } from 'apify';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import { processInput } from './input.js';
import { log } from './logger.js';
import { MCPClient } from './mcpClient.js';
import type { Input } from './types.js';

await Actor.init();

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';
let HOST: string | undefined;
let PORT: string | undefined;

if (Actor.isAtHome()) {
    HOST = STANDBY_MODE ? process.env.ACTOR_STANDBY_URL : process.env.ACTOR_WEB_SERVER_URL;
    PORT = Actor.isAtHome() ? process.env.ACTOR_STANDBY_PORT : process.env.ACTOR_WEB_SERVER_PORT;
} else {
    const filename = fileURLToPath(import.meta.url);
    const dirname = path.dirname(filename);
    dotenv.config({ path: path.resolve(dirname, '../.env') });
    HOST = 'http://localhost';
    PORT = '3000';
}

const app = express();
app.use(express.json());
app.use(cors());

// Serve your public folder (where index.html is located)
const filename = fileURLToPath(import.meta.url);
const publicPath = path.join(path.dirname(filename), 'public');
const publicUrl = Actor.isAtHome() ? HOST : `${HOST}:${PORT}`;
app.use(express.static(publicPath));

const input = await processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.debug(`systemPrompt: ${input.systemPrompt}`);
log.debug(`mcpSseUrl: ${input.mcpSseUrl}`);
log.debug(`modelName: ${input.modelName}`);

// 4) We'll store the SSE clients (browsers) in an array
type SSEClient = { id: number; res: express.Response };
let sseClients: SSEClient[] = [];
let clientIdCounter = 0;

// Create a single instance of your MCP client
const client = new MCPClient(
    input.mcpSseUrl,
    input.headers,
    input.systemPrompt,
    input.modelName,
    input.llmProviderApiKey,
    input.modelMaxOutputTokens,
    input.maxNumberOfToolCalls,
    input.toolCallTimeoutSec,
);

// 5) SSE endpoint for the client.js (browser) to connect to
app.get('/sse', (req, res) => {
    // Required headers for SSE
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.flushHeaders();

    const clientId = ++clientIdCounter;
    sseClients.push({ id: clientId, res });
    log.debug(`New SSE client: ${clientId}`);

    // If client closes connection, remove from array
    req.on('close', () => {
        log.debug(`SSE client disconnected: ${clientId}`);
        sseClients = sseClients.filter((c) => c.id !== clientId);
    });
});

// 6) POST /message from the browser
app.post('/message', async (req, res) => {
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Missing "query" field' });
    }
    try {
        // We call MyMcpClient, passing a callback that broadcasts SSE events
        await client.processUserQuery(query, (role, content) => {
            broadcastSSE({ role, content });
        });
        return res.json({ ok: true });
    } catch (err) {
        log.error(`Error in processing user query: ${err}`);
        return res.json({ error: (err as Error).message });
    }
});

app.get('/client-info', (_req, res) => {
    // If you have these values in config or environment, adapt as needed.
    res.json({
        mcpSseUrl: input.mcpSseUrl,
        systemPrompt: input.systemPrompt,
        modelName: input.modelName,
        publicUrl,
    });
});

/**
 * Broadcasts an event to all connected SSE clients
 */
function broadcastSSE(data: object) {
    for (const c of sseClients) {
        c.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

app.get('*', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, () => {
    log.info(`Serving from path ${path.join(publicPath, 'index.html')}`);
    log.info(`Navigate to ${publicUrl} in your browser to interact with an MCP server.`);
});
