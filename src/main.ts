import path from 'path';
import { fileURLToPath } from 'url';

import { Actor } from 'apify';
import express from 'express';
import type { Request, Response } from 'express';

import { processInput } from './input.js';
import { log } from './logger.js';
import { MCPClient } from './mcpClient.js';
import type { Input } from './types.js';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

await Actor.init();

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';
const HOST = Actor.isAtHome() ? process.env.ACTOR_STANDBY_URL : 'http://localhost';
const PORT = Actor.isAtHome() ? process.env.ACTOR_STANDBY_PORT : 3001;

const app = express();
app.use(express.json());

// Serve your public folder (where index.html is located)
// Adjust if you keep it in a different directory
app.use(express.static(path.join(dirname, 'public')));

const input = await processInput((await Actor.getInput<Partial<Input>>()) ?? ({} as Input));
log.info(`Loaded input: ${JSON.stringify(input)} `);

if (Actor.isAtHome()) {
    if (!input.headers) {
        input.headers = {};
    }
    input.headers = { ...input.headers, Authorization: `Bearer ${process.env.APIFY_TOKEN}` };
}

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
let isConnected = false;

/**
 * POST /api/chat
 * Receives: { query: string, messages: MessageParam[] }
 * Returns: { newMessages: MessageParam[] }
 */
app.post('/chat', async (req: Request, res: Response) : Promise<Response> => {
    try {
        console.log('Received POST /api/chat:'); // eslint-disable-line no-console
        const { query, messages } = req.body;
        if (!isConnected) {
            // Connect to server once, the same way your original code does
            // Pass the arguments needed for your server script if needed:
            await client.connectToServer();
            isConnected = true;
        }
        // process the query with your existing logic
        const nrMessagesBefore = messages.length;
        const updatedMessages = await client.processQuery(query, messages);

        // newMessages = whatever was appended to messages by the call
        // i.e. everything after the original length
        const newMessages = updatedMessages.slice(nrMessagesBefore);

        return res.json({ newMessages });
    } catch (error) {
        console.error('Error in /chat:', error); // eslint-disable-line no-console
        res.status(500).json({ error: (error as Error).message || 'Internal server error' });
        return res.end();
    }
});

app.use((req: Request, res: Response) => {
    res.status(404).json({ message: `There is nothing at route ${req.method} ${req.originalUrl}, use only root /` }).end();
});

if (STANDBY_MODE) {
    log.info('Actor is running in the STANDBY mode.');
    app.listen(PORT, () => {
        log.info(`Open chatbot application at ${HOST}`);
    });
} else {
    log.info('Actor is not designed to run in the NORMAL model');
    app.listen(PORT, () => {
        log.info(`Open chatbot application at ${HOST}`);
    });
}
