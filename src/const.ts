import inputSchema from '../.actor/input_schema.json' with { type: 'json' };

export const defaults = {
    mcpUrl: inputSchema.properties.mcpUrl.default,
    systemPrompt: inputSchema.properties.systemPrompt.default,
    modelName: inputSchema.properties.modelName.default,
    customModelName: '',
    modelMaxOutputTokens: inputSchema.properties.modelMaxOutputTokens.default,
    maxNumberOfToolCallsPerQuery: inputSchema.properties.maxNumberOfToolCallsPerQuery.default,
    toolCallTimeoutSec: inputSchema.properties.toolCallTimeoutSec.default,
};

export const MISSING_PARAMETER_ERROR = `Either provide parameter as Actor input or as query parameter: `;

export const BASIC_INFORMATION = 'Once you have the Tester MCP Client running, you can ask:\n'
    + '- "What Apify Actors I can use"\n'
    + '- "Which Actor is the best for scraping Instagram comments"\n'
    + "- \"Can you scrape the first 10 pages of Google search results for 'best restaurants in Prague'?\"\n"
    + '\n';

export const Event = {
    ACTOR_STARTED: 'actor-start',
    ACTOR_RUNNING_TIME: 'actor-running-time',
    INPUT_TOKENS_GPT4: 'input-tokens-gpt4',
    OUTPUT_TOKENS_GPT4: 'output-tokens-gpt4',
    INPUT_TOKENS_GPT35: 'input-tokens-gpt35',
    OUTPUT_TOKENS_GPT35: 'output-tokens-gpt35',
    INPUT_TOKENS_GPT4_TURBO: 'input-tokens-gpt4-turbo',
    OUTPUT_TOKENS_GPT4_TURBO: 'output-tokens-gpt4-turbo',
    QUERY_ANSWERED: 'query-answered',
};

export const CONVERSATION_RECORD_NAME = 'CONVERSATION';

export const IMAGE_BASE64_PLACEHOLDER = '[Base64 encoded content - image was pruned to save context tokens]';
