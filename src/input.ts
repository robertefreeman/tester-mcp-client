import { defaults, MISSING_PARAMETER_ERROR } from './const.js';
import { log } from './logger.js';
import type { Input, StandbyInput } from './types.js';

let isChargingForTokens = true;

export function getChargeForTokens() {
    return isChargingForTokens;
}

/**
 * Process input parameters, split actors string into an array
 * @param originalInput
 * @returns input
 */
export function processInput(originalInput: Partial<Input> | Partial<StandbyInput>): Input {
    const input = { ...defaults, ...originalInput } as StandbyInput;

    // MCP SSE URL is deprecated, use MCP URL instead
    if (input.mcpSseUrl && !input.mcpUrl) {
        input.mcpUrl = input.mcpSseUrl;
    }
    if (!input.mcpUrl) {
        throw new Error(`MCP Server URL is not provided. ${MISSING_PARAMETER_ERROR}: 'mcpUrl'`);
    }

    if (input.mcpTransportType === 'http-streamable-json-response' && input.mcpUrl.includes('/sse')) {
        throw new Error(`MCP URL includes /sse path, but the transport is set to 'http-streamable'. This is very likely a mistake.`);
    }

    if (input.mcpUrl.includes('/sse')) {
        input.mcpTransportType = 'sse';
    } else {
        input.mcpTransportType = 'http-streamable-json-response';
    }

    if (!input.headers) {
        input.headers = {};
    }
    if (input.headers && typeof input.headers === 'string') {
        try {
            input.headers = JSON.parse(input.headers);
        } catch (error) {
            throw new Error(`Invalid JSON string in headers: ${(error as Error).message}`);
        }
    }
    // Automatically add APIFY_TOKEN to Authorization header (if not present)
    if (typeof input.headers === 'object' && !('Authorization' in input.headers) && process.env.APIFY_TOKEN) {
        input.headers = { ...input.headers, Authorization: `Bearer ${process.env.APIFY_TOKEN}` };
    }

    if (!input.modelName) {
        throw new Error(`LLM model name is not provided. ${MISSING_PARAMETER_ERROR}: 'modelName'`);
    }

    // Handle custom model names and environment variable override
    if (input.modelName === 'custom' && input.customModelName) {
        input.modelName = input.customModelName;
    }
    
    // Allow MODEL_NAME environment variable to override the model name
    if (process.env.MODEL_NAME) {
        input.modelName = process.env.MODEL_NAME;
        log.info(`Model name overridden by environment variable: ${input.modelName}`);
    }

    if (input.llmProviderApiKey && input.llmProviderApiKey !== '') {
        log.info('Using user provided API key for an LLM provider');
        isChargingForTokens = false;
    } else {
        log.info('No API key provided for an LLM provider, Actor will charge for tokens usage');
        input.llmProviderApiKey = process.env.LLM_PROVIDER_API_KEY ?? '';
    }

    // Set base URL from environment if not provided
    if (!input.llmProviderBaseUrl) {
        input.llmProviderBaseUrl = process.env.LLM_PROVIDER_BASE_URL;
    }

    return input as Input;
}
