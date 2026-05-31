/**
 * LLM Proxy - Proxies LLM API calls (OpenAI, Anthropic, MiniMax, etc.)
 * 
 * Intercepts LLM API calls, injects the real API key from vault,
 * and logs all requests for audit purposes.
 */

import { DecryptedCredential } from '../credential-vault';
import { AuditLogger } from './audit-logger';
import { TokenPayload } from '../consumer-token';

interface LLMRequest {
  model?: string;
  messages?: any[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: any;
}

interface LLMResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: any[];
  usage?: any;
}

interface LLMConfig {
  baseUrl: string;
  provider: string;
}

export class LLMProxy {
  private vault: any;
  private auditLogger: AuditLogger;
  private providerCache: Map<string, LLMConfig> = new Map();

  constructor(vault: any, auditLogger: AuditLogger) {
    this.vault = vault;
    this.auditLogger = auditLogger;
    this.initProviderDefaults();
  }

  /**
   * Initialize default provider configurations
   */
  private initProviderDefaults(): void {
    this.providerCache.set('openai', {
      baseUrl: 'https://api.openai.com/v1',
      provider: 'openai',
    });
    this.providerCache.set('anthropic', {
      baseUrl: 'https://api.anthropic.com/v1',
      provider: 'anthropic',
    });
    this.providerCache.set('minimax', {
      baseUrl: 'https://api.minimax.chat/v1',
      provider: 'minimax',
    });
    this.providerCache.set('google', {
      baseUrl: 'https://generativelanguage.googleapis.com/v1',
      provider: 'google',
    });
    this.providerCache.set('ollama', {
      baseUrl: 'http://localhost:11434/v1',
      provider: 'ollama',
    });
  }

  /**
   * Get provider config for a model
   */
  private getProviderForModel(model: string): LLMConfig {
    const modelLower = model.toLowerCase();
    
    if (modelLower.includes('gpt') || modelLower.includes('o1') || modelLower.includes('o3')) {
      return this.providerCache.get('openai')!;
    }
    if (modelLower.includes('claude')) {
      return this.providerCache.get('anthropic')!;
    }
    if (modelLower.includes('minimax') || modelLower.includes('abab')) {
      return this.providerCache.get('minimax')!;
    }
    if (modelLower.includes('gemini')) {
      return this.providerCache.get('google')!;
    }
    if (modelLower.includes('llama') || modelLower.includes('mistral') || modelLower.includes('qwen')) {
      return this.providerCache.get('ollama')!;
    }
    
    // Default to OpenAI-compatible
    return this.providerCache.get('openai')!;
  }

  /**
   * Proxy an LLM API request
   */
  async proxy(
    tokenPayload: TokenPayload,
    endpoint: string,
    method: string,
    body: LLMRequest,
    headers: any
  ): Promise<any> {
    const model = body?.model || 'gpt-4o';
    const providerConfig = this.getProviderForModel(model);

    // Get the real API key from vault
    let credential = await this.vault.getCredentialByType('llm', providerConfig.provider);

    if (!credential) {
      // Fallback: try any LLM credential
      const anyCredential = await this.vault.getCredentialByType('llm');
      if (!anyCredential) {
        throw { message: 'No LLM credential configured', statusCode: 503 };
      }
      credential = anyCredential;
    }

    // Build the target URL
    const targetUrl = this.buildTargetUrl(providerConfig.baseUrl, endpoint, body);
    
    // Build request headers
    const requestHeaders = this.buildRequestHeaders(providerConfig.provider, credential.key, headers);

    // Log the request
    this.auditLogger.logLLMRequest({
      workerId: tokenPayload.workerId,
      role: tokenPayload.role,
      tokenId: tokenPayload.jti,
      provider: providerConfig.provider,
      model,
      endpoint,
      requestBody: body,
    });

    // Make the actual API call
    const response = await this.makeRequest(targetUrl, method, requestHeaders, body);

    return response;
  }

  /**
   * Build the target URL for the LLM API
   */
  private buildTargetUrl(baseUrl: string, endpoint: string, body?: LLMRequest): string {
    const url = `${baseUrl}/${endpoint}`;
    
    // For OpenAI-compatible APIs, handle chat/completions specially
    if (endpoint === 'chat/completions' && body?.model) {
      // Some providers need model in URL path
      // Keep model in body for most providers
    }
    
    return url;
  }

  /**
   * Build request headers for the LLM provider
   */
  private buildRequestHeaders(provider: string, apiKey: string, originalHeaders: any): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    switch (provider) {
      case 'openai':
      case 'ollama':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      case 'anthropic':
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
      case 'minimax':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      case 'google':
        headers['Authorization'] = `Bearer ${apiKey}`;
        break;
      default:
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Copy relevant headers from original request
    if (originalHeaders['openai-organization']) {
      headers['OpenAI-Organization'] = originalHeaders['openai-organization'];
    }

    return headers;
  }

  /**
   * Make the actual HTTP request to the LLM provider
   */
  private async makeRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: any
  ): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();
        throw {
          message: `LLM API error: ${response.status} ${response.statusText}`,
          statusCode: response.status,
          details: errorBody,
        };
      }

      const contentType = response.headers.get('content-type');
      if (contentType?.includes('text/event-stream')) {
        // For streaming responses, return the raw body
        return { 
          _streaming: true, 
          _url: url,
          _headers: Object.fromEntries(response.headers.entries())
        };
      }

      return await response.json();
    } catch (error: any) {
      clearTimeout(timeout);
      
      if (error.name === 'AbortError') {
        throw { message: 'LLM request timeout', statusCode: 504 };
      }
      
      throw error;
    }
  }

  /**
   * Handle streaming response (for SSE)
   */
  async handleStreaming(response: Response, outputStream: any): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw { message: 'No response body', statusCode: 500 };
    }

    const decoder = new TextDecoder();
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        outputStream.write(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  }
}
