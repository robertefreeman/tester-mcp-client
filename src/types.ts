export type Input = {
    llmProviderApiKey: string,
    modelName: string,
    headers: Record<string, string>,
    maxNumberOfToolCalls: number,
    modelMaxOutputTokens: number,
    mcpServerUrl: string,
    systemPrompt: string,
    toolCallTimeoutSec: number,
};

export type StandbyInput = Input & {
    headers: string | Record<string, string>,
}
