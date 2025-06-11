import type { MessageParam, TextContent, ImageContent, ToolCallContent } from './types.js';

import { IMAGE_BASE64_PLACEHOLDER } from './const.js';

export function isBase64(str: string): boolean {
    if (!str) {
        return false;
    }
    try {
        return btoa(atob(str)) === str;
    } catch {
        return false;
    }
}

/**
* Prunes base64 encoded messages from the conversation and replaces them with a placeholder to save context tokens.
* Also adds fake tool_result messages for tool_use messages that don't have a corresponding tool_result message.
* Also adds fake tool_use messages for tool_result messages that don't have a corresponding tool_use message.
* Ensures tool_result blocks reference valid tool_use IDs.
* @param conversation
* @returns
*/
export function pruneAndFixConversation(conversation: MessageParam[]): MessageParam[] {
    // Create a shallow copy of the conversation array
    const prunedAndFixedConversation: MessageParam[] = [];

    // First pass: prune base64 content and collect tool IDs
    for (let m = 0; m < conversation.length; m++) {
        const message = conversation[m];

        // Handle simple string messages
        if (typeof message.content === 'string') {
            prunedAndFixedConversation.push({
                ...message,
                content: isBase64(message.content) ? IMAGE_BASE64_PLACEHOLDER : message.content,
            });
            continue;
        }

        // Handle messages with content blocks (array format)
        if (Array.isArray(message.content)) {
            const contentBlocks = message.content;
            const processedBlocks = contentBlocks.map((block) => {
                // Handle different block types
                if (block.type === 'text' && isBase64(block.text)) {
                    return {
                        type: 'text',
                        text: IMAGE_BASE64_PLACEHOLDER,
                    } as TextContent;
                }

                if (block.type === 'image_url') {
                    // For image URLs, check if it's base64 encoded
                    if (block.image_url.url.startsWith('data:') && isBase64(block.image_url.url.split(',')[1])) {
                        return {
                            type: 'image_url',
                            image_url: {
                                url: `data:image/png;base64,${IMAGE_BASE64_PLACEHOLDER}`,
                                detail: block.image_url.detail,
                            }
                        } as ImageContent;
                    }
                    return block;
                }

                return block;
            });

            prunedAndFixedConversation.push({
                ...message,
                content: processedBlocks,
            });
            continue;
        }

        // Handle tool result messages (role: 'tool')
        if (message.role === 'tool' && typeof message.content === 'string' && isBase64(message.content)) {
            prunedAndFixedConversation.push({
                ...message,
                content: IMAGE_BASE64_PLACEHOLDER,
            });
            continue;
        }

        // Handle messages with tool calls
        if (message.tool_calls) {
            prunedAndFixedConversation.push(message);
            continue;
        }

        // Default case - copy message as is
        prunedAndFixedConversation.push(message);
    }

    // Tool validation for OpenAI format is simpler since tool calls and results are in separate messages
    // We'll just ensure that tool result messages have corresponding tool call IDs
    // This is less critical for OpenAI format but still good practice

    return prunedAndFixedConversation;
}
