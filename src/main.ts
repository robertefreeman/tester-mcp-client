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

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Actor } from 'apify';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';

import { createClient } from './clientFactory.js';
import { BASIC_INFORMATION, CONVERSATION_RECORD_NAME, Event } from './const.js';
import { ConversationManager } from './conversationManager.js';
import { Counter } from './counter.js';
import { processInput, getChargeForTokens } from './input.js';
import { log } from './logger.js';
import type { TokenCharger, Input } from './types.js';
import inputSchema from '../.actor/input_schema.json' with { type: 'json' };

// Default max context tokens constant
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;

await Actor.init();

/**
 * Charge for token usage
 * We don't want to implement this in the MCPClient as we want to have MCP Client independent of Apify Actor
 */
export class ActorTokenCharger implements TokenCharger {
    async chargeTokens(inputTokens: number, outputTokens: number, modelName: string): Promise<void> {
        let eventNameInput: string;
        let eventNameOutput: string;
        
        // Handle standard OpenAI models with specific billing events
        switch (modelName) {
            case 'gpt-3.5-turbo':
                eventNameInput = Event.INPUT_TOKENS_GPT35;
                eventNameOutput = Event.OUTPUT_TOKENS_GPT35;
                break;
            case 'gpt-4':
                eventNameInput = Event.INPUT_TOKENS_GPT4;
                eventNameOutput = Event.OUTPUT_TOKENS_GPT4;
                break;
            case 'gpt-4-turbo':
                eventNameInput = Event.INPUT_TOKENS_GPT4_TURBO;
                eventNameOutput = Event.OUTPUT_TOKENS_GPT4_TURBO;
                break;
            default:
                // For custom models (Ollama, vLLM, local models, etc.), use GPT-4 billing as default
                // This provides a reasonable approximation for unknown model costs
                eventNameInput = Event.INPUT_TOKENS_GPT4;
                eventNameOutput = Event.OUTPUT_TOKENS_GPT4;
                log.info(`Using GPT-4 billing rates for custom model: ${modelName}`);
                break;
        }
        
        try {
            await Actor.charge({ eventName: eventNameInput, count: Math.ceil(inputTokens / 100) });
            await Actor.charge({ eventName: eventNameOutput, count: Math.ceil(outputTokens / 100) });
            log.info(`Charged ${inputTokens} input tokens (query+tools) and ${outputTokens} output tokens for model: ${modelName}`);
        } catch (error) {
            log.error('Failed to charge for token usage', { error });
            throw error;
        }
    }
}

// Add after Actor.init()
const RUNNING_TIME_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
setInterval(async () => {
    try {
        log.info('Charging for running time (every 5 minutes)');
        await Actor.charge({ eventName: Event.ACTOR_RUNNING_TIME });
    } catch (error) {
        log.error('Failed to charge for running time', { error });
    }
}, RUNNING_TIME_INTERVAL);

try {
    log.info('Charging Actor start event.');
    await Actor.charge({ eventName: Event.ACTOR_STARTED });
} catch (error) {
    log.error('Failed to charge for actor start event', { error });
    await Actor.exit('Failed to charge for actor start event');
}

const STANDBY_MODE = Actor.getEnv().metaOrigin === 'STANDBY';
const ACTOR_IS_AT_HOME = Actor.isAtHome();
let HOST: string | undefined;
let PORT: string | undefined;

if (ACTOR_IS_AT_HOME) {
    HOST = STANDBY_MODE ? process.env.ACTOR_STANDBY_URL : process.env.ACTOR_WEB_SERVER_URL;
    PORT = ACTOR_IS_AT_HOME ? process.env.ACTOR_STANDBY_PORT : process.env.ACTOR_WEB_SERVER_PORT;
} else {
    const filename = fileURLToPath(import.meta.url);
    const dirname = path.dirname(filename);
    dotenv.config({ path: path.resolve(dirname, '../.env') });
    HOST = 'http://localhost';
    PORT = '5001';
}

// Add near the top after Actor.init()
let ACTOR_TIMEOUT_AT: number | undefined;
try {
    ACTOR_TIMEOUT_AT = process.env.ACTOR_TIMEOUT_AT ? new Date(process.env.ACTOR_TIMEOUT_AT).getTime() : undefined;
} catch {
    ACTOR_TIMEOUT_AT = undefined;
}

const actorInput = (await Actor.getInput<Partial<Input>>()) ?? ({} as Input);
const input = processInput(actorInput ?? ({} as Input));

log.debug(`systemPrompt: ${input.systemPrompt}`);
log.debug(`mcpUrl: ${input.mcpUrl || 'No MCP URL - running without MCP server'}`);
log.debug(`mcpTransport: ${input.mcpTransportType}`);
log.debug(`modelName: ${input.modelName}`);

if (!input.llmProviderApiKey) {
    log.error('No API key provided for LLM provider. Report this issue to Actor developer.');
    await Actor.exit('No API key provided for LLM provider. Report this issue to Actor developer.');
}

let runtimeSettings = {
    mcpUrl: input.mcpUrl,
    mcpTransportType: input.mcpTransportType,
    systemPrompt: input.systemPrompt,
    modelName: input.modelName,
    modelMaxOutputTokens: input.modelMaxOutputTokens,
    maxNumberOfToolCallsPerQuery: input.maxNumberOfToolCallsPerQuery,
    toolCallTimeoutSec: input.toolCallTimeoutSec,
};

const app = express();

// Configure Content Security Policy to allow font loading
app.use((_req, res, next) => {
    // Set CSP header to allow fonts from CDN and self
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "font-src 'self' https://cdnjs.cloudflare.com data:",
        "style-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'",
        "img-src 'self' https://apify.com data:",
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self'"
    ].join('; '));
    next();
});

app.use(express.json());
app.use(cors());

// Serve your public folder (where index.html is located)
const filename = fileURLToPath(import.meta.url);
// In Docker, the structure is different - static files are in /app/src/public
const isDist = filename.includes('/dist/');
const publicPath = isDist
    ? path.join(process.cwd(), 'src', 'public')  // Docker: /app/src/public
    : path.join(path.dirname(filename), 'public'); // Local dev: src/public
const publicUrl = ACTOR_IS_AT_HOME ? HOST : `${HOST}:${PORT}`;


app.use(express.static(publicPath));

const persistedConversation = (await Actor.getValue<import('./types.js').MessageParam[]>(CONVERSATION_RECORD_NAME)) ?? [];
const conversationCounter = new Counter(persistedConversation.length);

// DEBUG: Log final configuration before creating ConversationManager
log.info(`[DEBUG] Final Configuration for ConversationManager:`, {
    llmProviderBaseUrl: input.llmProviderBaseUrl,
    modelName: input.modelName,
    hasApiKey: !!input.llmProviderApiKey,
    systemPrompt: input.systemPrompt?.substring(0, 100) + '...',
    allEnvVars: {
        LLM_PROVIDER_BASE_URL: process.env.LLM_PROVIDER_BASE_URL,
        LLM_PROVIDER_API_KEY: process.env.LLM_PROVIDER_API_KEY ? 'SET' : 'NOT_SET',
        MODEL_NAME: process.env.MODEL_NAME
    }
});

const conversationManager = new ConversationManager(
    input.systemPrompt,
    input.modelName,
    input.llmProviderApiKey,
    input.modelMaxOutputTokens,
    input.maxNumberOfToolCallsPerQuery,
    input.toolCallTimeoutSec,
    getChargeForTokens() ? new ActorTokenCharger() : null,
    persistedConversation,
    DEFAULT_MAX_CONTEXT_TOKENS,
    input.llmProviderBaseUrl,
);

// This should not be needed, but just in case
Actor.on('migrating', async () => {
    log.debug(`Migrating ... persisting conversation.`);
    await Actor.setValue(CONVERSATION_RECORD_NAME, conversationManager.getConversation());
});

// Only one browser client can be connected at a time
type BrowserSSEClient = { id: number; res: express.Response };
let browserClients: BrowserSSEClient[] = [];
let nextClientId = 1;

// Create a single instance of your MCP client (client is connected to the MCP-server)
let client: Client | null = null;

// 5) SSE endpoint for the client.js (browser)
app.get('/sse', async (req, res) => {
    // Required headers for SSE
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable proxy buffering
    });
    res.flushHeaders();

    const clientId = nextClientId++;
    const keepAliveInterval = setInterval(() => {
        res.write(':\n\n'); // Send a comment as a keepalive
    }, 5000); // Send keepalive every 5 seconds

    browserClients.push({ id: clientId, res });
    log.debug(`Browser client ${clientId} connected`);

    // If a client closes connection, clear an interval and remove from an array
    req.on('close', () => {
        log.debug(`Browser client ${clientId} disconnected`);
        clearInterval(keepAliveInterval);
        browserClients = browserClients.filter((browserClient) => browserClient.id !== clientId);
    });

    // Handle client timeout
    req.on('timeout', () => {
        log.debug(`Browser client ${clientId} timeout`);
        clearInterval(keepAliveInterval);
        browserClients = browserClients.filter((browserClient) => browserClient.id !== clientId);
        res.end();
    });
});

/**
 * Helper function to create or get existing MCP client
 * @returns Client instance or null if no MCP URL is configured
 */
async function getOrCreateClient(): Promise<Client | null> {
    log.debug('Getting or creating MCP client');
    
    // If no MCP URL is configured, return null
    if (!runtimeSettings.mcpUrl) {
        log.debug('No MCP URL configured, skipping client creation');
        return null;
    }
    
    if (!client) {
        log.debug('Creating new MCP client');
        try {
            client = await createClient(
                runtimeSettings.mcpUrl,
                runtimeSettings.mcpTransportType,
                input.headers,
                async (tools) => await conversationManager.handleToolUpdate(tools),
                (notification) => conversationManager.handleNotification(notification),
            );
        } catch (err) {
            const error = err as Error;
            log.error('Failed to connect to MCP server', { error: error.message, stack: error.stack });
            throw new Error(`${error.message}`);
        }
    }
    return client;
}

/**
 * Helper function to handle client cleanup based on transport type
 */
async function cleanupClient(): Promise<void> {
    if (input.mcpTransportType === 'http-streamable-json-response' && client) {
        try {
            await client.close();
            client = null;
        } catch (err) {
            const error = err as Error;
            log.error('Failed to close client connection', { error: error.message, stack: error.stack });
        }
    }
}

// /message endpoint for the client.js (browser)
app.post('/message', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing "query" field' });

    try {
        // Process the query
        await Actor.pushData({ role: 'user', content: query });
        const mcpClient = await getOrCreateClient();
        
        // Check if we have an MCP client or if we should process without tools
        if (mcpClient) {
            await conversationManager.processUserQuery(mcpClient, query, async (role, content) => {
                // Key used for sorting messages in the client UI
                const key = conversationCounter.increment();
                await broadcastSSE({
                    role,
                    content,
                    key,
                });
            });
        } else {
            // Process without MCP tools - just use the LLM
            log.info('Processing query without MCP tools');
            const response = await conversationManager.processQueryWithoutTools(query);
            const key = conversationCounter.increment();
            await broadcastSSE({
                role: 'assistant',
                content: response,
                key,
            });
        }
        // Charge for task completion
        await Actor.charge({ eventName: Event.QUERY_ANSWERED, count: 1 });
        log.info(`Charged query answered event`);

        // Send a finished flag
        await broadcastSSE({ role: 'system', content: '', finished: true });
        return res.json({ ok: true });
    } catch (err) {
        const error = err as Error;
        log.exception(error, `Error in processing user query: ${query}`);
        // Send finished flag with error
        await broadcastSSE({ role: 'system', content: error.message, finished: true, error: true });
        return res.json({ ok: false, error: error.message });
    }
});

/**
 * Periodically check if the main server is still reachable.
 */
app.get('/reconnect-mcp-server', async (_req, res) => {
    try {
        const mcpClient = await getOrCreateClient();
        if (!mcpClient) {
            return res.json({ status: 'NO_MCP_SERVER', message: 'No MCP server configured' });
        }
        await mcpClient.ping();
        return res.json({ status: 'OK' });
    } catch (err) {
        const error = err as Error;
        return res.json({ ok: false, error: error.message });
    }
});

/**
 * GET /client-info endpoint to provide the client with necessary information
 */
app.get('/client-info', (_req, res) => {
    res.json({
        mcpUrl: runtimeSettings.mcpUrl,
        mcpTransportType: runtimeSettings.mcpTransportType,
        systemPrompt: runtimeSettings.systemPrompt,
        modelName: runtimeSettings.modelName,
        publicUrl,
        information: BASIC_INFORMATION,
    });
});

/**
 * GET /check-timeout endpoint to check if the Actor is about to timeout
 */
app.get('/check-actor-timeout', (_req, res) => {
    if (!ACTOR_TIMEOUT_AT) {
        return res.json({ timeoutImminent: false });
    }

    const now = Date.now();
    const timeUntilTimeout = ACTOR_TIMEOUT_AT - now;
    const timeoutImminent = timeUntilTimeout < 60000; // Less than 1 minute remaining

    return res.json({
        timeoutImminent,
        timeUntilTimeout,
        timeoutAt: ACTOR_TIMEOUT_AT,
    });
});

/**
 * POST /conversation/reset to reset the conversation
 */
app.post('/conversation/reset', async (_req, res) => {
    log.debug('Resetting conversation');
    conversationManager.resetConversation();
    await Actor.setValue(CONVERSATION_RECORD_NAME, conversationManager.getConversation());
    res.json({ ok: true });
});

/**
 * GET /available-tools endpoint to fetch available tools
 */
app.get('/available-tools', async (_req, res) => {
    try {
        const mcpClient = await getOrCreateClient();
        if (!mcpClient) {
            // No MCP server configured, return empty tools
            return res.json({ tools: [] });
        }
        const tools = await conversationManager.updateAndGetTools(mcpClient);
        return res.json({ tools });
    } catch (err) {
        const error = err as Error;
        log.error(`Error fetching tools: ${error.message}`);
        return res.status(500).json({ error: 'Failed to fetch tools' });
    }
});

/**
 * GET /settings endpoint to retrieve current settings
 */
app.get('/settings', (_req, res) => {
    res.json({
        ...runtimeSettings,
        llmProviderBaseUrl: input.llmProviderBaseUrl || '',
    });
});

/**
 * GET /schema/models endpoint to retrieve available model options from input schema
 */
app.get('/schema/models', (_req, res) => {
    try {
        const { enum: models, enumTitles } = inputSchema.properties.modelName;
        const modelOptions = models.map((model: string, index: number) => ({
            value: model,
            label: enumTitles[index],
        }));
        res.json(modelOptions);
    } catch (error) {
        // Fallback if schema is not available
        const defaultModels = [
            { value: 'gpt-4-turbo', label: 'GPT-4 Turbo (OpenAI)' },
            { value: 'gpt-4', label: 'GPT-4 (OpenAI)' },
            { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (OpenAI)' },
            { value: 'custom', label: 'Custom Model Name' },
        ];
        res.json(defaultModels);
    }
});

/**
 * GET /available-models endpoint to fetch available models from the LLM provider
 */
app.get('/available-models', async (_req, res) => {
    try {
        const baseUrl = input.llmProviderBaseUrl || 'https://api.openai.com/v1';
        const apiKey = input.llmProviderApiKey;
        
        if (!apiKey) {
            log.error('No API key available for fetching models');
            res.status(500).json({ error: 'No API key configured for LLM provider' });
            return;
        }

        // Construct the models endpoint URL
        const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`;
        
        log.debug(`Fetching models from: ${modelsUrl}`);
        
        const response = await fetch(modelsUrl, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            log.error(`Failed to fetch models: ${response.status} ${response.statusText}`);
            throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
        }

        const data = await response.json() as { data?: any[] };
        
        if (!data.data || !Array.isArray(data.data)) {
            log.error('Invalid response format from models endpoint');
            throw new Error('Invalid response format from models endpoint');
        }

        // Transform the response to match our expected format
        const modelOptions = data.data
            .filter((model: any) => model.id) // Filter out models without an ID
            .map((model: any) => ({
                value: model.id,
                label: model.id + (model.owned_by ? ` (${model.owned_by})` : ''),
                created: model.created,
                owned_by: model.owned_by,
            }))
            .sort((a: any, b: any) => a.label.localeCompare(b.label)); // Sort alphabetically

        log.debug(`Successfully fetched ${modelOptions.length} models`);
        res.json(modelOptions);
    } catch (error) {
        log.error(`Error fetching available models: ${error instanceof Error ? error.message : String(error)}`);
        
        // Fallback to static models from schema if dynamic fetch fails
        try {
            const { enum: models, enumTitles } = inputSchema.properties.modelName;
            const fallbackModels = models.map((model: string, index: number) => ({
                value: model,
                label: enumTitles[index],
            }));
            
            log.info('Falling back to static model list from schema');
            res.json(fallbackModels);
        } catch (fallbackError) {
            log.error(`Error providing fallback models: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
            res.status(500).json({ error: 'Failed to fetch models and no fallback available' });
        }
    }
});

/**
 * POST /settings endpoint to update settings
 */
app.post('/settings', async (req, res) => {
    try {
        const newSettings = req.body;
        if (newSettings.mcpUrl !== undefined && !newSettings.mcpUrl) {
            res.status(400).json({ success: false, error: 'MCP URL is required' });
            return;
        }
        if (newSettings.modelName !== undefined && !newSettings.modelName) {
            res.status(400).json({ success: false, error: 'Model name is required' });
            return;
        }
        
        // Handle llmProviderBaseUrl update - need to update the ConversationManager's OpenAI client
        const baseUrlChanged = newSettings.llmProviderBaseUrl !== undefined &&
            newSettings.llmProviderBaseUrl !== input.llmProviderBaseUrl;
        
        runtimeSettings = {
            ...runtimeSettings,
            ...newSettings,
        };
        
        // Update the input configuration if base URL changed
        if (baseUrlChanged) {
            input.llmProviderBaseUrl = newSettings.llmProviderBaseUrl;
        }
        await conversationManager.updateClientSettings({
            systemPrompt: runtimeSettings.systemPrompt,
            modelName: runtimeSettings.modelName,
            modelMaxOutputTokens: runtimeSettings.modelMaxOutputTokens,
            maxNumberOfToolCallsPerQuery: runtimeSettings.maxNumberOfToolCallsPerQuery,
            toolCallTimeoutSec: runtimeSettings.toolCallTimeoutSec,
        });

        // If base URL changed, we need to recreate the ConversationManager with the new OpenAI client
        if (baseUrlChanged) {
            const newConversationManager = new ConversationManager(
                runtimeSettings.systemPrompt,
                runtimeSettings.modelName,
                input.llmProviderApiKey,
                runtimeSettings.modelMaxOutputTokens,
                runtimeSettings.maxNumberOfToolCallsPerQuery,
                runtimeSettings.toolCallTimeoutSec,
                getChargeForTokens() ? new ActorTokenCharger() : null,
                conversationManager.getConversation(),
                DEFAULT_MAX_CONTEXT_TOKENS,
                input.llmProviderBaseUrl,
            );
            // Replace the global conversation manager instance
            Object.setPrototypeOf(conversationManager, Object.getPrototypeOf(newConversationManager));
            Object.assign(conversationManager, newConversationManager);
        }

        if (newSettings.mcpUrl !== undefined || newSettings.mcpTransportType !== undefined) {
            if (client) {
                try {
                    await client.close();
                } catch (err) {
                    log.warning('Error closing client connection:', { error: err });
                }
                client = null;
            }
            // The next API request will create a new client with updated settings
        }
        log.info(`Settings updated: ${JSON.stringify(runtimeSettings)}`);
        res.json({ success: true });
    } catch (error) {
        log.error('Error updating settings:', { error: (error instanceof Error) ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Failed to update settings' });
    }
});

/**
 * POST /settings/reset endpoint to reset settings to defaults
 */
app.post('/settings/reset', async (_req, res) => {
    try {
        runtimeSettings = {
            mcpUrl: input.mcpUrl,
            mcpTransportType: input.mcpTransportType,
            systemPrompt: input.systemPrompt,
            modelName: input.modelName,
            modelMaxOutputTokens: input.modelMaxOutputTokens,
            maxNumberOfToolCallsPerQuery: input.maxNumberOfToolCallsPerQuery,
            toolCallTimeoutSec: input.toolCallTimeoutSec,
        };
        await conversationManager.updateClientSettings({
            systemPrompt: runtimeSettings.systemPrompt,
            modelName: runtimeSettings.modelName,
            modelMaxOutputTokens: runtimeSettings.modelMaxOutputTokens,
            maxNumberOfToolCallsPerQuery: runtimeSettings.maxNumberOfToolCallsPerQuery,
            toolCallTimeoutSec: runtimeSettings.toolCallTimeoutSec,
        });

        // Close the existing client to force recreation with default settings
        if (client) {
            try {
                await client.close();
            } catch (err) {
                log.warning('Error closing client connection:', { error: err });
            }
            client = null;
        }
        res.json({ success: true });
    } catch (error) {
        log.error('Error resetting settings:', { error: (error instanceof Error) ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Failed to reset settings' });
    }
});

app.get('/conversation', (_req, res) => {
    res.json(conversationManager.getConversation());
});

app.get('*', (_req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

/**
 * Broadcasts an event to all connected SSE clients
 */
async function broadcastSSE(data: object) {
    log.debug('Push data into Apify dataset and persist conversation');
    await Actor.pushData(data);
    await Actor.setValue(CONVERSATION_RECORD_NAME, conversationManager.getConversation());

    log.debug(`Broadcasting message to ${browserClients.length} clients`);
    const message = `data: ${JSON.stringify(data)}\n\n`;
    browserClients.forEach((browserClient) => {
        browserClient.res.write(message);
    });
}

app.listen(PORT, async () => {
    log.info(`Serving from ${path.join(publicPath, 'index.html')}`);
    const msg = `Navigate to ${publicUrl} to interact with the chat UI.`;
    await Actor.setStatusMessage(msg);
});

// Fix Ctrl+C for npm run start
process.on('SIGINT', async () => {
    log.info('Received SIGINT. Cleaning up and exiting...');
    await cleanupClient();
    await Actor.exit('SIGINT received');
});
