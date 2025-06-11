export type Input = {
    llmProviderApiKey: string,
    llmProviderBaseUrl?: string,
    modelName: string,
    customModelName?: string,
    headers: Record<string, string>,
    maxNumberOfToolCallsPerQuery: number,
    modelMaxOutputTokens: number,
    /**
     * @deprecated MCP Use mcpUrl instead
     */
    mcpSseUrl: string,
    mcpUrl: string,
    mcpTransportType: 'sse' | 'http-streamable-json-response',
    systemPrompt: string,
    toolCallTimeoutSec: number,
};

export type StandbyInput = Input & {
    /**
     * @deprecated MCP Use mcpUrl instead
     */
    mcpSseUrl: string,
    mcpUrl: string,
    headers: string | Record<string, string>,
    customModelName?: string,
}

export type Tool = {
    name: string;
    description: string | undefined;
    input_schema: unknown;
}

/**
 * A function that charges tokens for a given model.
 * @param inputTokens - The number of input tokens.
 * @param outputTokens - The number of output tokens.
 * @param modelName - The name of the model.
 */
export interface TokenCharger {
    chargeTokens(inputTokens: number, outputTokens: number, modelName: string): Promise<void>;
}

// OpenAI-compatible message types
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type TextContent = {
    type: 'text';
    text: string;
};

export type ImageContent = {
    type: 'image_url';
    image_url: {
        url: string;
        detail?: 'low' | 'high' | 'auto';
    };
};

export type ToolCallContent = {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
};

export type ToolResultContent = {
    tool_call_id: string;
    content: string;
};

export type MessageContent = string | (TextContent | ImageContent)[];

export interface MessageParam {
    role: MessageRole;
    content: MessageContent;
    tool_calls?: ToolCallContent[];
    tool_call_id?: string;
    name?: string;
}

export interface MessageParamWithBlocks extends MessageParam {
    content: (TextContent | ImageContent)[];
}
