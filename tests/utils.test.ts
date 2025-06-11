import type { MessageParam } from '../src/types.js';
import { describe, it, expect } from 'vitest';

import { IMAGE_BASE64_PLACEHOLDER } from '../src/const.js';
import { pruneAndFixConversation } from '../src/utils.js';

describe('pruneAndFixConversation', () => {
    // Base 64 pruning
    it('should prune base64 encoded image content and replace with placeholder', () => {
        // A simple base64 string (not a real image, but enough for test)
        const base64String = 'aGVsbG8gd29ybGQ='; // "hello world" in base64
        const conversation: MessageParam[] = [
            { role: 'user', content: 'Show me an image' },
            { role: 'assistant', content: 'I will process your request' },
            { role: 'tool', content: base64String, tool_call_id: 'tool_img' },
        ];

        const result = pruneAndFixConversation(conversation);

        // Check that conversation is preserved
        expect(result.length).toBe(conversation.length);
        expect(result[0].role).toBe('user');
        expect(result[0].content).toBe('Show me an image');
        expect(result[1].role).toBe('assistant');
        expect(result[1].content).toBe('I will process your request');
        expect(result[2].role).toBe('tool');
        
        // Check string message is replaced
        expect(result[2].content).toBe(IMAGE_BASE64_PLACEHOLDER);
    });

    it('should prune base64 encoded string content and replace with placeholder', () => {
        const base64String = 'aGVsbG8gd29ybGQ='; // "hello world" in base64
        const conversation: MessageParam[] = [
            { role: 'user', content: base64String },
            { role: 'assistant', content: 'I received your message' },
        ];

        const result = pruneAndFixConversation(conversation);

        expect(result.length).toBe(conversation.length);
        expect(result[0].content).toBe(IMAGE_BASE64_PLACEHOLDER);
        expect(result[1].content).toBe('I received your message');
    });

    it('should prune base64 image URLs in content blocks', () => {
        const base64Data = 'aGVsbG8gd29ybGQ=';
        const conversation: MessageParam[] = [
            { 
                role: 'user', 
                content: [
                    { type: 'text', text: 'Here is an image:' },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } }
                ]
            },
            { role: 'assistant', content: 'I can see the image' },
        ];

        const result = pruneAndFixConversation(conversation);

        expect(result.length).toBe(conversation.length);
        expect(Array.isArray(result[0].content)).toBe(true);
        const content = result[0].content as any[];
        expect(content[0].type).toBe('text');
        expect(content[0].text).toBe('Here is an image:');
        expect(content[1].type).toBe('image_url');
        expect(content[1].image_url.url).toBe(`data:image/png;base64,${IMAGE_BASE64_PLACEHOLDER}`);
    });

    it('should preserve non-base64 content unchanged', () => {
        const conversation: MessageParam[] = [
            { role: 'user', content: 'Regular text message' },
            { 
                role: 'assistant', 
                content: [
                    { type: 'text', text: 'Regular response' }
                ]
            },
            { 
                role: 'assistant', 
                content: 'Simple string response',
                tool_calls: [
                    { 
                        id: 'call_123', 
                        type: 'function', 
                        function: { name: 'test_tool', arguments: '{}' } 
                    }
                ]
            },
            { role: 'tool', content: 'Tool result', tool_call_id: 'call_123' },
        ];

        const result = pruneAndFixConversation(conversation);

        expect(result.length).toBe(conversation.length);
        expect(result[0].content).toBe('Regular text message');
        expect(result[1].content).toEqual([{ type: 'text', text: 'Regular response' }]);
        expect(result[2].content).toBe('Simple string response');
        expect(result[2].tool_calls).toEqual([{ 
            id: 'call_123', 
            type: 'function', 
            function: { name: 'test_tool', arguments: '{}' } 
        }]);
        expect(result[3].content).toBe('Tool result');
        expect(result[3].tool_call_id).toBe('call_123');
    });
});
