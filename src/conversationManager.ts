/**
 * Create an MCP client that connects to the server using SSE transport
 *
 */

import OpenAI from 'openai';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ListToolsResult, Notification, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { log } from 'apify';
import { EventSource } from 'eventsource';

import type { MessageParamWithBlocks, TokenCharger, Tool, MessageParam, TextContent, ImageContent, ToolCallContent } from './types.js';
import { pruneAndFixConversation } from './utils.js';

if (typeof globalThis.EventSource === 'undefined') {
    globalThis.EventSource = EventSource as unknown as typeof globalThis.EventSource;
}

// Define a default, can be overridden in constructor
const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
// Define a safety margin to avoid edge cases
const CONTEXT_TOKEN_SAFETY_MARGIN = 0.99;
// Minimum number of messages to keep in the conversation
// This keeps one round of user and assistant messages
const MIN_CONVERSATION_LENGTH = 2;

export class ConversationManager {
    private conversation: MessageParam[] = [];
    private openai: OpenAI;
    private systemPrompt: string;
    private modelName: string;
    private modelMaxOutputTokens: number;
    private maxNumberOfToolCallsPerQueryRound: number;
    private toolCallTimeoutSec: number;
    private readonly tokenCharger: TokenCharger | null;
    private tools: Tool[] = [];
    private readonly maxContextTokens: number;

    constructor(
        systemPrompt: string,
        modelName: string,
        apiKey: string,
        modelMaxOutputTokens: number,
        maxNumberOfToolCallsPerQuery: number,
        toolCallTimeoutSec: number,
        tokenCharger: TokenCharger | null = null,
        persistedConversation: MessageParam[] = [],
        maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS,
        baseUrl?: string,
    ) {
        this.systemPrompt = systemPrompt;
        this.modelName = modelName;
        this.modelMaxOutputTokens = modelMaxOutputTokens;
        this.maxNumberOfToolCallsPerQueryRound = maxNumberOfToolCallsPerQuery;
        this.toolCallTimeoutSec = toolCallTimeoutSec;
        this.tokenCharger = tokenCharger;
        
        // DEBUG: Log LLM provider configuration
        const effectiveBaseUrl = baseUrl || 'https://api.openai.com/v1';
        log.info(`[DEBUG] LLM Provider Configuration:`, {
            baseUrl: effectiveBaseUrl,
            providedBaseUrl: baseUrl,
            modelName: modelName,
            hasApiKey: !!apiKey
        });
        
        this.openai = new OpenAI({
            apiKey,
            baseURL: baseUrl,
            defaultHeaders: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        this.conversation = [...persistedConversation];
        this.maxContextTokens = Math.floor(maxContextTokens * CONTEXT_TOKEN_SAFETY_MARGIN);
    }

    /**
     * Returns a flattened version of the conversation history, splitting messages with multiple content blocks
     * into separate messages for each block. Text blocks are returned as individual messages with string content,
     * while tool_use and tool_result blocks are returned as messages with a single-element content array.
     *
     * This is needed because of how the frontend client expects the conversation history to be structured.
     *
     * @returns {MessageParam[]} The flattened conversation history, with each message containing either a string (for text)
     *                           or an array with a single tool_use/tool_result block.
     */
    getConversation(): MessageParam[] {
        // split messages blocks into separate messages with text or single block
        const result: MessageParam[] = [];
        for (const message of this.conversation) {
            if (typeof message.content === 'string') {
                result.push(message);
                continue;
            }

            // Handle messages with content blocks
            if (Array.isArray(message.content)) {
                for (const block of message.content) {
                    if (block.type === 'text') {
                        result.push({
                            role: message.role,
                            content: block.text || '',
                        });
                    } else if (block.type === 'image_url') {
                        result.push({
                            role: message.role,
                            content: [block],
                        });
                    }
                }
            }

            // Handle tool calls
            if (message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    result.push({
                        role: message.role,
                        content: [toolCall as any],
                    });
                }
            }

            // Handle tool results
            if (message.tool_call_id) {
                result.push({
                    role: message.role,
                    content: message.content,
                });
            }
        }

        return result;
    }

    resetConversation() {
        this.conversation = [];
    }

    async handleToolUpdate(listTools: ListToolsResult) {
        this.tools = listTools.tools.map((x) => ({
            name: x.name,
            description: x.description,
            input_schema: x.inputSchema,
        }));
        log.debug(`Connected to server with tools: ${this.tools.map((x) => x.name)}`);
    }

    async updateAndGetTools(mcpClient: Client) {
        const tools = await mcpClient.listTools();
        await this.handleToolUpdate(tools);
        return this.tools;
    }

    /**
     * Update client settings with new values
     */
    async updateClientSettings(settings: {
        systemPrompt?: string;
        modelName?: string;
        modelMaxOutputTokens?: number;
        maxNumberOfToolCallsPerQuery?: number;
        toolCallTimeoutSec?: number;
    }): Promise<boolean> {
        if (settings.systemPrompt !== undefined) this.systemPrompt = settings.systemPrompt;
        if (settings.modelName !== undefined && settings.modelName !== this.modelName) this.modelName = settings.modelName;
        if (settings.modelMaxOutputTokens !== undefined) this.modelMaxOutputTokens = settings.modelMaxOutputTokens;
        if (settings.maxNumberOfToolCallsPerQuery !== undefined) this.maxNumberOfToolCallsPerQueryRound = settings.maxNumberOfToolCallsPerQuery;
        if (settings.toolCallTimeoutSec !== undefined) this.toolCallTimeoutSec = settings.toolCallTimeoutSec;

        return true;
    }

    /**
     * Count the number of tokens in the conversation history using OpenAI's token estimation.
     * @returns The number of tokens in the conversation.
     */
    private async countTokens(messages: MessageParam[]): Promise<number> {
        if (messages.length === 0) {
            return 0;
        }
        try {
            // Convert to OpenAI format for token counting
            const openaiMessages = this.convertToOpenAIMessages(messages);
            
            // Simple token estimation - OpenAI doesn't provide a direct API for token counting
            // We'll use a rough estimate: ~4 characters per token
            const totalContent = openaiMessages.reduce((acc, msg) => {
                if (typeof msg.content === 'string') {
                    return acc + msg.content.length;
                }
                return acc + JSON.stringify(msg.content).length;
            }, 0);
            
            // Add system prompt and tools to token count
            const systemTokens = this.systemPrompt.length;
            const toolsTokens = JSON.stringify(this.tools).length;
            
            return Math.ceil((totalContent + systemTokens + toolsTokens) / 4);
        } catch (error) {
            log.warning(`Error counting tokens: ${error instanceof Error ? error.message : String(error)}`);
            return Infinity;
        }
    }

    /**
     * Convert internal message format to OpenAI format
     */
    private convertToOpenAIMessages(messages: MessageParam[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
        const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
        
        // Add system message first
        if (this.systemPrompt) {
            openaiMessages.push({
                role: 'system',
                content: this.systemPrompt
            });
        }

        for (const message of messages) {
            if (message.role === 'system') continue; // Skip system messages in conversation as we handle it separately
            
            if (message.role === 'tool') {
                // Tool result message
                openaiMessages.push({
                    role: 'tool',
                    content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
                    tool_call_id: message.tool_call_id!
                });
            } else if (message.tool_calls) {
                // Assistant message with tool calls
                openaiMessages.push({
                    role: 'assistant',
                    content: typeof message.content === 'string' ? message.content : null,
                    tool_calls: message.tool_calls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.function.name,
                            arguments: tc.function.arguments
                        }
                    }))
                });
            } else {
                // Regular user or assistant message
                if (message.role === 'user') {
                    openaiMessages.push({
                        role: 'user',
                        content: typeof message.content === 'string'
                            ? message.content
                            : Array.isArray(message.content)
                                ? message.content.map(c => {
                                    if (c.type === 'text') {
                                        return { type: 'text', text: c.text };
                                    } else if (c.type === 'image_url') {
                                        return { type: 'image_url', image_url: c.image_url };
                                    }
                                    return c;
                                })
                                : JSON.stringify(message.content)
                    });
                } else if (message.role === 'assistant') {
                    openaiMessages.push({
                        role: 'assistant',
                        content: typeof message.content === 'string'
                            ? message.content
                            : Array.isArray(message.content)
                                ? message.content
                                    .filter(c => c.type === 'text')
                                    .map(c => c.text)
                                    .join('') || null
                                : JSON.stringify(message.content)
                    });
                }
            }
        }

        return openaiMessages;
    }

    /**
     * Convert OpenAI tools format to our internal format
     */
    private convertToOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
        return this.tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description || '',
                parameters: tool.input_schema as any
            }
        }));
    }

    /**
     * Ensures the conversation history does not exceed the maximum token limit.
     * Removes oldest messages if necessary.
     */
    private async ensureContextWindowLimit(): Promise<void> {
        if (this.conversation.length <= MIN_CONVERSATION_LENGTH) {
            return;
        }

        let currentTokens = await this.countTokens(this.conversation);
        log.debug(`[Context truncation] Current token count: ${currentTokens}, max allowed: ${this.maxContextTokens}`);
        if (currentTokens <= this.maxContextTokens) {
            log.info(`[Context truncation] Current token count (${currentTokens}) is within limit (${this.maxContextTokens}). No truncation needed.`);
            return;
        }

        log.info(`[Context truncation] Current token count (${currentTokens}) exceeds limit (${this.maxContextTokens}). Truncating conversation...`);
        const initialMessagesCount = this.conversation.length;

        while (currentTokens > this.maxContextTokens && this.conversation.length > MIN_CONVERSATION_LENGTH) {
            try {
                log.debug(`[Context truncation] Current token count: ${currentTokens}, removing oldest message... total messages length: ${this.conversation.length}`);
                // Truncate oldest user and assistant messages round
                // This has to be done because otherwise if we just remove the oldest message
                // we end up with more context token than we started with (it does not make sense but it happens)
                this.conversation.shift();
                this.conversation.shift();
                this.printConversation();
                this.conversation = pruneAndFixConversation(this.conversation);
                currentTokens = await this.countTokens(this.conversation);
                log.debug(`[Context truncation] New token count after removal: ${currentTokens}`);
                // Wait for a short period to avoid hitting the API too quickly
                await new Promise<void>((resolve) => {
                    setTimeout(() => resolve(), 5);
                });
            } catch (error) {
                log.error(`Error during context window limit check: ${error instanceof Error ? error.message : String(error)}`);
                break;
            }
        }
        log.info(`[Context truncation] Finished. Removed ${initialMessagesCount - this.conversation.length} messages. `
                  + `Current token count: ${currentTokens}. Messages remaining: ${this.conversation.length}.`);
        // This is here mostly like a safety net, but it should not be needed
        this.conversation = pruneAndFixConversation(this.conversation);
    }

    /**
     * @internal
     * Debugging helper function that prints the current conversation state to the log.
     * Iterates through all messages in the conversation, logging their roles and a truncated preview of their content.
     * For messages with content blocks, logs details for each block, including text, tool usage, and tool results.
     * Useful for inspecting the structure and flow of the conversation during development or troubleshooting.
     */
    private printConversation() {
        log.debug(`[internal] createMessageWithRetry conversation length: ${this.conversation.length}`);
        for (const message of this.conversation) {
            log.debug(`[internal] ----- createMessageWithRetry message role: ${message.role} -----`);
            if (typeof message.content === 'string') {
                log.debug(`[internal] createMessageWithRetry message content: ${message.role}: ${message.content.substring(0, 50)}...`);
                continue;
            }
            if (Array.isArray(message.content)) {
                for (const block of message.content) {
                    if (block.type === 'text') {
                        log.debug(`[internal] createMessageWithRetry block text: ${message.role}: ${block.text?.substring(0, 50)}...`);
                    } else if (block.type === 'image_url') {
                        log.debug(`[internal] createMessageWithRetry block image: ${message.role}: ${block.image_url.url.substring(0, 50)}...`);
                    }
                }
            }
            if (message.tool_calls) {
                for (const toolCall of message.tool_calls) {
                    log.debug(`[internal] createMessageWithRetry tool_call: ${toolCall.function.name}, input: ${toolCall.function.arguments.substring(0, 50)}...`);
                }
            }
            if (message.tool_call_id) {
                const contentStr = typeof message.content === 'string'
                    ? message.content
                    : JSON.stringify(message.content ?? '');
                log.debug(`[internal] createMessageWithRetry tool_result: ${message.tool_call_id}, content: ${contentStr.substring(0, 50)}...`);
            }
        }
    }

    private async createMessageWithRetry(
        maxRetries = 3,
        retryDelayMs = 2000, // 2 seconds
    ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
        // Check context window before API call
        this.conversation = pruneAndFixConversation(this.conversation);
        await this.ensureContextWindowLimit();

        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                log.debug(`Making API call with ${this.conversation.length} messages`);
                
                const openaiMessages = this.convertToOpenAIMessages(this.conversation);
                const openaiTools = this.convertToOpenAITools();
                
                const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
                    model: this.modelName,
                    messages: openaiMessages,
                    max_tokens: this.modelMaxOutputTokens,
                };

                if (openaiTools.length > 0) {
                    params.tools = openaiTools;
                    params.tool_choice = 'auto';
                }

                const response = await this.openai.chat.completions.create(params);
                
                if (this.tokenCharger && response.usage) {
                    const inputTokens = response.usage.prompt_tokens ?? 0;
                    const outputTokens = response.usage.completion_tokens ?? 0;
                    await this.tokenCharger.chargeTokens(inputTokens, outputTokens, this.modelName);
                }
                return response;
            } catch (error) {
                lastError = error as Error;
                if (error instanceof Error) {
                    if (error.message.includes('429') || error.message.includes('529')) {
                        if (attempt < maxRetries) {
                            const delay = attempt * retryDelayMs;
                            const errorType = error.message.includes('429') ? 'Rate limit' : 'Server overload';
                            log.debug(`${errorType} hit, attempt ${attempt}/${maxRetries}. Retrying in ${delay / 1000} seconds...`);
                            await new Promise<void>((resolve) => {
                                setTimeout(() => resolve(), delay);
                            });
                            continue;
                        } else {
                            const errorType = error.message.includes('429') ? 'Rate limit' : 'Server overload';
                            const errorMsg = errorType === 'Rate limit'
                                ? `Rate limit exceeded after ${maxRetries} attempts. Please try again in a few minutes or consider switching to a different model`
                                : 'Server is currently experiencing high load. Please try again in a few moments or consider switching to a different model.';
                            throw new Error(errorMsg);
                        }
                    }
                }
                // For other errors, throw immediately
                throw error;
            }
        }
        throw lastError ?? new Error('Unknown error after retries in createMessageWithRetry');
    }

    /**
     * Handles the response from the LLM (Large Language Model), processes text and tool_use blocks,
     * emits SSE events, manages tool execution, and recursively continues the conversation as needed.
     */
    async handleLLMResponse(client: Client, response: OpenAI.Chat.Completions.ChatCompletion, sseEmit: (role: string, content: string | any[]) => void, toolCallCountRound = 0) {
        log.debug(`[internal] handleLLMResponse: ${JSON.stringify(response)}`);

        const choice = response.choices[0];
        if (!choice?.message) {
            throw new Error('No message in OpenAI response');
        }

        const message = choice.message;
        
        // Create assistant message
        const assistantMessage: MessageParam = {
            role: 'assistant',
            content: message.content || '',
        };

        // Handle text content
        if (message.content) {
            log.debug(`[internal] emitting SSE text message: ${message.content}`);
            sseEmit('assistant', message.content);
        }

        // Handle tool calls
        if (message.tool_calls && message.tool_calls.length > 0) {
            if (toolCallCountRound >= this.maxNumberOfToolCallsPerQueryRound) {
                const msg = `Too many tool calls in a single turn! This has been implemented to prevent infinite loops.\nLimit is ${this.maxNumberOfToolCallsPerQueryRound}.\nYou can increase the limit by setting the "maxNumberOfToolCallsPerQuery" parameter.`;
                assistantMessage.content = (assistantMessage.content || '') + '\n' + msg;
                log.debug(`[internal] emitting SSE tool limit message: ${msg}`);
                sseEmit('assistant', msg);
                this.conversation.push(assistantMessage);
                return;
            }

            assistantMessage.tool_calls = message.tool_calls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments
                }
            }));

            // Emit tool calls
            for (const toolCall of message.tool_calls) {
                log.debug(`[internal] emitting SSE tool_call message: ${JSON.stringify(toolCall)}`);
                sseEmit('assistant', [toolCall]);
            }
        }

        this.conversation.push(assistantMessage);

        // If no tool calls, we're done
        if (!message.tool_calls || message.tool_calls.length === 0) {
            log.debug('[internal] No tool calls found, returning from handleLLMResponse');
            return;
        }

        // Handle tool calls
        for (const toolCall of message.tool_calls) {
            const params = { 
                name: toolCall.function.name, 
                arguments: JSON.parse(toolCall.function.arguments) 
            };
            log.debug(`[internal] Calling tool (count: ${toolCallCountRound}): ${JSON.stringify(params)}`);
            
            let toolResult: string;
            let isError = false;
            
            try {
                const results = await client.callTool(params, CallToolResultSchema, { timeout: this.toolCallTimeoutSec * 1000 });
                if (results && typeof results === 'object' && 'content' in results) {
                    toolResult = this.processToolResults(results as CallToolResult, params.name);
                } else {
                    log.warning(`Tool ${params.name} returned unexpected result format:`, results);
                    toolResult = `Tool "${params.name}" returned unexpected result format: ${JSON.stringify(results, null, 2)}`;
                }
            } catch (error) {
                log.error(`Error when calling tool ${params.name}: ${error}`);
                toolResult = `Error when calling tool ${params.name}, error: ${error}`;
                isError = true;
            }

            // Create tool result message
            const toolResultMessage: MessageParam = {
                role: 'tool',
                content: toolResult,
                tool_call_id: toolCall.id
            };

            this.conversation.push(toolResultMessage);
            log.debug(`[internal] emitting SSE tool_result message: ${JSON.stringify(toolResultMessage)}`);
            sseEmit('user', [{ tool_call_id: toolCall.id, content: toolResult, is_error: isError }]);
        }

        // Get next response from model
        log.debug('[internal] Get model response from tool result');
        const nextResponse = await this.createMessageWithRetry();
        log.debug('[internal] Received response from model');
        
        // Process the next response recursively
        await this.handleLLMResponse(client, nextResponse, sseEmit, toolCallCountRound + 1);
        log.debug('[internal] Finished processing tool result');
    }

    /**
     * Process a user query:
     * 1) Use OpenAI to generate a response (which may contain "tool_calls").
     * 2) If "tool_calls" is present, call the main actor's tool via `this.mcpClient.callTool()`.
     * 3) Return or yield partial results so we can SSE them to the browser.
     */
    async processUserQuery(client: Client, query: string, sseEmit: (role: string, content: string | any[]) => void) {
        log.debug(`[internal] Call LLM with user query: ${JSON.stringify(query)}`);
        this.conversation.push({ role: 'user', content: query });

        try {
            const response = await this.createMessageWithRetry();
            log.debug(`[internal] Received response: ${JSON.stringify(response.choices[0]?.message)}`);
            log.debug(`[internal] Token count: ${JSON.stringify(response.usage)}`);
            await this.handleLLMResponse(client, response, sseEmit);
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.conversation.push({ role: 'assistant', content: errorMsg });
            sseEmit('assistant', errorMsg);
            throw new Error(errorMsg);
        }
    }

    /**
     * Process a user query without MCP tools - just use the LLM directly
     */
    async processQueryWithoutTools(query: string): Promise<string> {
        log.debug(`[internal] Processing query without MCP tools: ${JSON.stringify(query)}`);
        this.conversation.push({ role: 'user', content: query });

        // Temporarily clear tools to ensure no tool calls are made
        const originalTools = this.tools;
        this.tools = [];

        try {
            const response = await this.createMessageWithRetry();
            log.debug(`[internal] Received response: ${JSON.stringify(response.choices[0]?.message)}`);
            log.debug(`[internal] Token count: ${JSON.stringify(response.usage)}`);
            
            const message = response.choices[0]?.message;
            if (!message) {
                throw new Error('No message in response');
            }

            const content = message.content || 'I apologize, but I was unable to generate a response.';
            this.conversation.push({ role: 'assistant', content });
            
            return content;
        } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            this.conversation.push({ role: 'assistant', content: errorMsg });
            throw new Error(errorMsg);
        } finally {
            // Restore tools
            this.tools = originalTools;
        }
    }

    handleNotification(notification: Notification) {
        // Implement logic to handle the notification
        log.info(`Handling notification: ${JSON.stringify(notification)}`);
        // You can update the conversation or perform other actions based on the notification
    }

    /**
     * Process tool call results and convert them into appropriate content
     */
    private processToolResults(results: CallToolResult, toolName: string): string {
        if (!results.content || !Array.isArray(results.content) || results.content.length === 0) {
            return `No results retrieved from ${toolName}`;
        }
        
        let processedContent = `Tool "${toolName}" executed successfully. Results:\n`;
        
        for (const item of results.content) {
            if (item.type === 'image' && item.data) {
                processedContent += `[Image data received - ${item.data.length} characters]\n`;
            } else if (item.type === 'text' && item.text) {
                processedContent += item.text + '\n';
            } else if (item.data) {
                processedContent += typeof item.data === 'string' ? item.data : JSON.stringify(item.data, null, 2);
                processedContent += '\n';
            }
        }
        
        return processedContent.trim();
    }

    /**
     * Detect image format from base64 data
     */
    private detectImageFormat(imageData: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' {
        try {
            const header = imageData.substring(0, 20);
            if (header.startsWith('/9j/')) {
                return 'image/jpeg';
            }
            if (header.startsWith('iVBORw0KGgo')) {
                return 'image/png';
            }
            // Binary signature detection
            const binaryString = atob(imageData.substring(0, 20));
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            // PNG signature: 89 50 4E 47 0D 0A 1A 0A
            if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
                return 'image/png';
            }
            if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
                return 'image/jpeg';
            }
            if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
                return 'image/webp';
            }
            return 'image/png'; // Default fallback
        } catch (error) {
            log.warning(`Could not detect image format, using default PNG: ${error}`);
            return 'image/png';
        }
    }
}
