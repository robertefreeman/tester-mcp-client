import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { processInput } from '../src/input.js';
import type { Input, StandbyInput } from '../src/types.js';

describe('Custom Model Name Support', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        originalEnv = { ...process.env };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('should use custom model name when modelName is "custom" and customModelName is provided', () => {
        const input: Partial<StandbyInput> = {
            mcpUrl: 'http://test.com',
            modelName: 'custom',
            customModelName: 'llama2:13b',
        };

        const result = processInput(input);
        expect(result.modelName).toBe('llama2:13b');
    });

    it('should override model name with MODEL_NAME environment variable', () => {
        process.env.MODEL_NAME = 'mistral:7b';

        const input: Partial<StandbyInput> = {
            mcpUrl: 'http://test.com',
            modelName: 'gpt-4',
        };

        const result = processInput(input);
        expect(result.modelName).toBe('mistral:7b');
    });

    it('should prioritize MODEL_NAME environment variable over custom model name', () => {
        process.env.MODEL_NAME = 'phi3:mini';

        const input: Partial<StandbyInput> = {
            mcpUrl: 'http://test.com',
            modelName: 'custom',
            customModelName: 'llama2:7b',
        };

        const result = processInput(input);
        expect(result.modelName).toBe('phi3:mini');
    });

    it('should use standard OpenAI model names without modification', () => {
        const input: Partial<StandbyInput> = {
            mcpUrl: 'http://test.com',
            modelName: 'gpt-4-turbo',
        };

        const result = processInput(input);
        expect(result.modelName).toBe('gpt-4-turbo');
    });

    it('should use local model names directly', () => {
        const input: Partial<StandbyInput> = {
            mcpUrl: 'http://test.com',
            modelName: 'codellama:34b',
        };

        const result = processInput(input);
        expect(result.modelName).toBe('codellama:34b');
    });
});