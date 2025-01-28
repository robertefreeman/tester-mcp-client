/**
 * Create an MCP client that connects to the server using SSE transport.
 *
 */

import path from 'path';
import { fileURLToPath } from 'url';

import { Anthropic } from '@anthropic-ai/sdk';
import type { Message, MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import dotenv from 'dotenv';
import { EventSource } from 'eventsource';

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

dotenv.config({ path: path.resolve(dirname, '../../.env') });

// const MAX_TOKENS = 2048; // Maximum tokens for Claude response

// const CLAUDE_MODEL = 'claude-3-5-sonnet-20241022'; // the most intelligent model
// const CLAUDE_MODEL = 'claude-3-5-haiku-20241022'; // a fastest model
// const CLAUDE_MODEL = 'claude-3-haiku-20240307'; // a fastest and most compact model for near-instant responsiveness

// const SYSTEM_PROMPT = 'You are a helpful Apify assistant with to tools called Actors\n'
//     + '\n'
//     + 'Your goal is to help users discover the best Actors for their needs\n'
//     + 'You have access to a list of tools that can help you to discover Actor, find details and include them among tools for later execution\n'
//     + '\n'
//     + 'Choose the appropriate tool based on the user\'s question. If no tool is needed, reply directly.\n'
//     + 'Prefer tools from Apify as they are generally more reliable and have better support\n'
//     + '\n'
//     + 'When you need to use a tool, explain how the tools was used and with which parameters\n'
//     + 'Never call a tool unless it is required by user!\n'
//     + '\n'
//     + 'After receiving a tool\'s response:\n'
//     + '1. Transform the raw data into a natural, conversational response\n'
//     + '2. Keep responses concise but informative\n'
//     + '3. Focus on the most relevant information\n'
//     + '4. Use appropriate context from the user\'s question\n'
//     + '5. Avoid simply repeating the raw data\n'
//     + '\n'
//     + 'Always use Actor not actor'
//     + 'Provide an URL to Actor whenever possible such as [apify_rag-web-browser](https://apify.com/apify/rag-web-browser)'
//     + '\n'
//     + 'REMEMBER Always limit number of results returned from Actors/tools. '
//     + 'There is always parameter such as maxResults=1, maxPage=1, maxCrawledPlacesPerSearch=1, keep it to minimal value.'
//     + 'Otherwise tool execution takes long and result is huge!';
//
if (typeof globalThis.EventSource === 'undefined') {
    globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

export type Tool = {
    name: string;
    description: string | undefined;
    input_schema: unknown;
}

export class MCPClient {
    private conversation: MessageParam[] = [];
    private _isConnected = false;
    private anthropic: Anthropic;
    private readonly serverUrl: string;
    private readonly customHeaders: Record<string, string> | null;
    private readonly systemPrompt: string;
    private readonly modelName: string;
    private readonly modelMaxOutputTokens: number;
    private readonly maxNumberOfToolCalls: number;
    private readonly toolCallTimeoutSec: number;
    private client = new Client(
        { name: 'example-client', version: '0.1.0' },
        { capabilities: {} },
    );

    private tools: Tool[] = [];

    constructor(
        serverUrl: string,
        headers: Record<string, string> | null,
        systemPrompt: string,
        modelName: string,
        apiKey: string,
        modelMaxOutputTokens: number,
        maxNumberOfToolCalls: number,
        toolCallTimeoutSec: number,
    ) {
        this.serverUrl = serverUrl;
        this.systemPrompt = systemPrompt;
        this.customHeaders = headers;
        this.modelName = modelName;
        this.modelMaxOutputTokens = modelMaxOutputTokens;
        this.maxNumberOfToolCalls = maxNumberOfToolCalls;
        this.toolCallTimeoutSec = toolCallTimeoutSec;
        this.anthropic = new Anthropic({ apiKey });
    }

    /**
     * Start the server using node and provided server script path.
     * Connect to the server using stdio transport and list available tools.
     */
    async connectToServer() {
        if (this.isConnected) return;
        const { customHeaders } = this;
        const transport = new SSEClientTransport(
            new URL(this.serverUrl),
            {
                requestInit: { headers: this.customHeaders || undefined },
                eventSourceInit: {
                    // The EventSource package augments EventSourceInit with a "fetch" parameter.
                    // You can use this to set additional headers on the outgoing request.
                    // Based on this example: https://github.com/modelcontextprotocol/typescript-sdk/issues/118
                    async fetch(input: Request | URL | string, init?: RequestInit) {
                        const headers = new Headers({ ...(init?.headers || {}), ...customHeaders });
                        return fetch(input, { ...init, headers });
                    },
                    // We have to cast to "any" to use it, since it's non-standard
                } as any, // eslint-disable-line @typescript-eslint/no-explicit-any
            },
        );
        await this.client.connect(transport);
        await this.updateTools();
        this._isConnected = true;
    }

    get isConnected() {
        return this._isConnected;
    }

    async updateTools() {
        const response = await this.client.listTools();
        this.tools = response.tools.map((x) => ({
            name: x.name,
            description: x.description,
            input_schema: x.inputSchema,
        }));
        log.debug(`Connected to server with tools: ${this.tools.map((x) => x.name)}`);
    }

    /**
     * Process LLM response and check whether it contains any tool calls.
     * If a tool call is found, call the tool and return the response and save the results to messages with type: user.
     * If the tools response is too large, truncate it to the limit.
     * If the number of tool calls exceeds the limit, return an error message.
     */
    async handleLLMResponse(
        response: Message,
        sseEmit: (role: string, content: string | ContentBlockParam[]) => void,
        toolCallCount = 0,
    ) {
        for (const block of response.content) {
            if (block.type === 'text') {
                this.conversation.push({ role: 'assistant', content: block.text || '' });
                sseEmit('assistant', block.text || '');
            } else if (block.type === 'tool_use') {
                if (toolCallCount > this.maxNumberOfToolCalls) {
                    this.conversation.push({ role: 'assistant', content: `Too many tool calls!` });
                    sseEmit('assistant', `Too many tool calls! Limit is ${this.maxNumberOfToolCalls}`);
                    return;
                }
                const msgAssistant = {
                    role: 'assistant' as const,
                    content: [{ id: block.id, input: block.input, name: block.name, type: 'tool_use' as const }],
                };
                sseEmit(msgAssistant.role, msgAssistant.content);
                this.conversation.push(msgAssistant);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const params = { name: block.name, arguments: block.input as any };
                log.debug(`[internal] Calling tool (count: ${toolCallCount}): ${JSON.stringify(params)}`);
                let results;
                const msgUser = {
                    role: 'user' as const,
                    content: [{
                        tool_use_id: block.id,
                        type: 'tool_result' as const,
                        content: '',
                        is_error: false,
                    }],
                };
                try {
                    results = await this.client.callTool(params, CallToolResultSchema, { timeout: this.toolCallTimeoutSec * 1000 });
                    if (results.content instanceof Array && results.content.length !== 0) {
                        const text = results.content.map((x) => x.text);
                        msgUser.content[0].content = text.join('\n\n');
                    } else {
                        msgUser.content[0].content = `No results retrieved from ${params.name}`;
                        msgUser.content[0].is_error = true;
                    }
                } catch (error) {
                    msgUser.content[0].content = `Error when calling tool ${params.name}, error: ${error}`;
                    msgUser.content[0].is_error = true;
                }
                sseEmit(msgUser.role, msgUser.content);
                this.conversation.push(msgUser);
                await this.updateTools(); // update tools in the case a new tool was added
                // Get next response from Claude
                log.debug('[internal] Get model response from tool result');
                const nextResponse: Message = await this.anthropic.messages.create({
                    model: this.modelName,
                    max_tokens: this.modelMaxOutputTokens,
                    messages: this.conversation,
                    system: this.systemPrompt,
                    tools: this.tools as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
                });
                await this.handleLLMResponse(nextResponse, sseEmit, toolCallCount + 1);
            }
        }
    }

    /**
     * Process a user query:
     * 1) Use Anthropic to generate a response (which may contain "tool_use").
     * 2) If "tool_use" is present, call the main actor's tool via `this.mcpClient.callTool()`.
     * 3) Return or yield partial results so we can SSE them to the browser.
     */
    async processUserQuery(query: string, sseEmit: (role: string, content: string | ContentBlockParam[]) => void): Promise<void> {
        await this.connectToServer(); // ensure connected
        this.conversation.push({ role: 'user', content: query });

        const response: Message = await this.anthropic.messages.create({
            model: this.modelName,
            max_tokens: this.modelMaxOutputTokens,
            messages: this.conversation,
            system: this.systemPrompt,
            tools: this.tools as any[], // eslint-disable-line @typescript-eslint/no-explicit-any
        });
        log.debug(`[internal] Received response: ${JSON.stringify(response.content)}`);
        await this.handleLLMResponse(response, sseEmit);
    }
}
