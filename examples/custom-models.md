# Custom Model Names Support

The OpenAI-compatible MCP Client now supports custom model names for use with various OpenAI-compatible endpoints like Ollama, vLLM, and local models.

## Configuration Options

### 1. Using the Input Schema

In the Actor input configuration, you can:

- **Select predefined models**: Choose from OpenAI models (gpt-4, gpt-3.5-turbo) or popular local models (llama2, codellama, mistral, etc.)
- **Use custom model names**: Select "Custom Model Name" and specify any model name in the "Custom Model Name" field

### 2. Using Environment Variables

For Docker deployments, you can override the model name at runtime:

```bash
# Set custom model name via environment variable
export MODEL_NAME="llama2:13b"
docker-compose up
```

In docker-compose.yaml:
```yaml
environment:
  - MODEL_NAME=llama2:13b
```

## Example Configurations

### Ollama Models
```json
{
  "modelName": "custom",
  "customModelName": "llama2:7b",
  "llmProviderBaseUrl": "http://localhost:11434/v1"
}
```

### vLLM Endpoint
```json
{
  "modelName": "custom", 
  "customModelName": "microsoft/DialoGPT-medium",
  "llmProviderBaseUrl": "http://your-vllm-server:8000/v1"
}
```

### Local Model Server
```json
{
  "modelName": "custom",
  "customModelName": "my-fine-tuned-model",
  "llmProviderBaseUrl": "http://localhost:8080/v1"
}
```

## Supported Model Names

### OpenAI Models (Standard)
- `gpt-4-turbo`
- `gpt-4` 
- `gpt-3.5-turbo`

### Popular Local Models (Predefined Options)
- `llama2`, `llama2:7b`, `llama2:13b`, `llama2:70b`
- `codellama`, `codellama:7b`, `codellama:13b`, `codellama:34b`
- `mistral`, `mistral:7b`, `mixtral:8x7b`
- `phi3`, `phi3:mini`
- `gemma:2b`, `gemma:7b`

### Custom Models
Any model name supported by your OpenAI-compatible endpoint can be used with the "Custom Model Name" option.

## Token Billing

- **OpenAI models** (gpt-4, gpt-3.5-turbo, gpt-4-turbo): Use specific billing rates
- **Custom models**: Default to GPT-4 billing rates as a reasonable approximation
- **User-provided API keys**: No token billing (free usage)

## Environment Variable Priority

The `MODEL_NAME` environment variable takes highest priority:

1. `MODEL_NAME` environment variable (highest priority)
2. `customModelName` when `modelName` is "custom"  
3. Selected `modelName` from input schema (lowest priority)

This allows flexible runtime configuration for different deployment scenarios.