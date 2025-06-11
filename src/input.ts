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
        log.info(`Using deprecated mcpSseUrl: ${input.mcpUrl}`);
    }
    
    // Make MCP URL optional - if not provided or is the default Apify URL with placeholder, set to empty
    if (!input.mcpUrl || (input.mcpUrl.includes('api.apify.com') && input.mcpUrl.includes('YOUR_TOKEN'))) {
        log.info('No valid MCP URL provided, running without MCP server');
        input.mcpUrl = '';
    }

    // Only process MCP URL if one is provided
    if (input.mcpUrl) {
        // Parse authorization from URL if present
        const parsedUrl = new URL(input.mcpUrl);
        const urlParams = parsedUrl.searchParams.toString();

        // Check for Authorization in the format ?Authorization:token
        if (urlParams.includes('Authorization:')) {
            const authMatch = urlParams.match(/Authorization:([^&]+)/);
            if (authMatch && authMatch[1]) {
                const authToken = authMatch[1];
                log.info(`Found authorization token in URL, extracting and moving to headers`);

                // Initialize headers if not present
                if (!input.headers) {
                    input.headers = {};
                }

                // Add the authorization header
                if (typeof input.headers === 'object') {
                    input.headers.Authorization = `Bearer ${authToken}`;
                }
                
                // Remove the Authorization parameter from the URL
                const cleanUrl = input.mcpUrl.replace(/\?Authorization:[^&]+/, '');
                input.mcpUrl = cleanUrl;
                log.debug(`Cleaned MCP URL: ${input.mcpUrl}`);
                log.debug(`Authorization header set: Bearer ${authToken.substring(0, 10)}...`);
            }
        }

        // Special handling for Apify API URLs with token parameter
        if (input.mcpUrl.includes('api.apify.com') && parsedUrl.searchParams.has('token')) {
            const token = parsedUrl.searchParams.get('token');

            if (token === 'YOUR_TOKEN') {
                // Use APIFY_TOKEN from environment if placeholder is found
                if (process.env.APIFY_TOKEN && process.env.APIFY_TOKEN !== 'test_token') {
                    parsedUrl.searchParams.set('token', process.env.APIFY_TOKEN);
                    input.mcpUrl = parsedUrl.toString();
                    log.info('Replaced YOUR_TOKEN placeholder with APIFY_TOKEN from environment');
                } else {
                    // Instead of throwing error, just clear the URL to run without MCP
                    log.info('Apify URL has placeholder token and no APIFY_TOKEN set, running without MCP server');
                    input.mcpUrl = '';
                }
            }
        }

        if (input.mcpUrl) {
            if (input.mcpTransportType === 'http-streamable-json-response' && input.mcpUrl.includes('/sse')) {
                throw new Error(`MCP URL includes /sse path, but the transport is set to 'http-streamable'. This is very likely a mistake.`);
            }

            if (input.mcpUrl.includes('/sse')) {
                input.mcpTransportType = 'sse';
            } else {
                input.mcpTransportType = 'http-streamable-json-response';
            }
        }
    } else {
        // No MCP URL provided, set default transport type
        input.mcpTransportType = 'http-streamable-json-response';
    }

    // Parse headers if they're a string
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

    // Ensure headers is an object at this point
    if (typeof input.headers !== 'object') {
        input.headers = {};
    }

    // Automatically add APIFY_TOKEN to Authorization header for Apify URLs only (if not present)
    if (!('Authorization' in input.headers) && process.env.APIFY_TOKEN && input.mcpUrl.includes('api.apify.com')) {
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

    // DEBUG: Log all LLM provider related configuration
    log.info(`[DEBUG] LLM Provider Input Processing:`, {
        inputBaseUrl: input.llmProviderBaseUrl,
        envBaseUrl: process.env.LLM_PROVIDER_BASE_URL,
        inputApiKey: input.llmProviderApiKey ? 'SET' : 'NOT_SET',
        envApiKey: process.env.LLM_PROVIDER_API_KEY ? 'SET' : 'NOT_SET',
        modelName: input.modelName,
        envModelName: process.env.MODEL_NAME
    });

    return input as Input;
}
