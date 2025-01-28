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
import express from 'express';
import type { Request, Response } from 'express';

import { processInput } from './input.js';
import { log } from './logger.js';
import { MCPClient } from './mcpClient.js';
import type { Input } from './types.js';

await Actor.init();

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';
const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL : 'http://localhost';
const PORT = Actor.isAtHome() ? process.env.ACTOR_STANDBY_PORT : 3000;

const app = express();
app.use(express.json());
app.use(cors());

// Serve your public folder (where index.html is located)
const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
app.use(express.static(path.join(dirname, 'public')));

const input = await processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info(`Loaded input: ${JSON.stringify(input)} `);

if (Actor.isAtHome()) {
    if (!input.headers) {
        input.headers = {};
    }
    input.headers = { ...input.headers, Authorization: `Bearer ${process.env.APIFY_TOKEN}` };
}

// 4) We'll store the SSE clients (browsers) in an array
type SSEClient = { id: number; res: express.Response };
let sseClients: SSEClient[] = [];
let clientIdCounter = 0;

// Create a single instance of your MCP client
const client = new MCPClient(
    input.mcpServerUrl,
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
    console.log(`New SSE client: ${clientId}`);

    // If client closes connection, remove from array
    req.on('close', () => {
        console.log(`SSE client disconnected: ${clientId}`);
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
        console.error('Error in processing user query:', err);
        return res.json({ error: (err as Error).message });
    }
});

/**
 * Broadcasts an event to all connected SSE clients
 */
function broadcastSSE(data: object) {
    for (const c of sseClients) {
        c.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

app.use((req: Request, res: Response) => {
    res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}, use only root /` }).end();
});

app.listen(PORT, () => {
    console.log(`Client actor listening on port ${PORT}, SSE at /sse, message at /message`);
});
