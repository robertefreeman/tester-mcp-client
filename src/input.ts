import { defaults } from './const.js';
import type { Input, StandbyInput } from './types.js';

/**
 * Process input parameters, split actors string into an array
 * @param originalInput
 * @returns input
 */
export async function processInput(originalInput: Partial<Input> | Partial<StandbyInput>): Promise<Input> {
    const input = { ...originalInput, ...defaults } as StandbyInput;

    if (!input.mcpServerUrl) {
        throw new Error('MCP Server URL is not provided');
    }

    if (input.headers && typeof input.headers === 'string') {
        input.headers = JSON.parse(input.headers);
    }

    if (!input.modelName) {
        throw new Error('LLM model is not provided');
    }

    if (!input.llmProviderApiKey) {
        throw new Error('API key for LLM is not provided');
    }
    return input;
}
