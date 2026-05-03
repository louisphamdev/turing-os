/**
 * Intent Parser — Natural Language → Structured Worker Commands
 * 
 * Parses admin's free-text messages in worker rooms into structured
 * commands that workers can execute dynamically.
 * 
 * Supported command types:
 * - register_tool: Inject a new tool into the worker
 * - unregister_tool: Remove a tool from the worker
 * - update_config: Update agent configuration (max_iterations, etc.)
 * - set_system_prompt: Update the system prompt
 * - reload_role: Reload role spec from wiki
 * - inspect: Query worker state (tools, config, etc.)
 */

import { config } from '../config';

export interface WorkerCommand {
  type: 'register_tool' | 'unregister_tool' | 'update_config' | 'set_system_prompt' | 'reload_role' | 'inspect' | 'unknown';
  args: Record<string, any>;
  raw: string; // Original message for debugging
  confidence: number; // 0-1, how confident the parser is
}

interface LLMIntentResult {
  command: WorkerCommand;
  error?: string;
}

/**
 * Parse natural language message into structured command using LLM
 */
export async function parseIntent(
  message: string,
  ticketId: string,
  sender: string
): Promise<LLMIntentResult> {
  const llmProvider = config.llm.provider.toLowerCase();
  const apiKey = config.llm.apiKey;
  const baseUrl = config.llm.baseUrl;
  const model = config.llm.model;

  const systemPrompt = `You are an intent parser for Turing OS worker management.

Given an admin's message directed at a worker, extract the intended command.

## Command Types

### register_tool
Register a new tool into the worker agent.
Args: { tool_name: string, tool_module?: string, tool_function?: string }
Example: "worker ABC123, thêm tool grep_search vào"
Example: "add the fetch_webpage tool to worker XYZ"

### unregister_tool  
Remove a tool from the worker agent.
Args: { tool_name: string }
Example: "worker ABC, remove the read_file tool"

### update_config
Update agent configuration parameters.
Args: { max_iterations?: number, tool_timeout?: number, [key: string]: any }
Example: "worker ABC, set max_iterations to 20"
Example: "tăng max_iterations lên 30 cho worker ABC"

### set_system_prompt
Update the worker's system prompt.
Args: { prompt: string }
Example: "worker ABC, update system prompt to: You are a senior..."

### reload_role
Reload the role specification from wiki.
Args: { role_spec_url?: string } (defaults to standard role wiki page)
Example: "worker ABC, reload the software-engineer role spec"

### reload_skills
Reload skills from skills.sh based on role or custom list.
Args: { skills?: string } (comma-separated, uses role defaults if not specified)
Example: "worker ABC, reload skills"
Example: "worker ABC, reload python,docker,git"

### inspect
Query current worker state (returns what tools/config are active).
Args: { query: "tools" | "config" | "all" | "role" | "wiki_tools" }
Example: "worker ABC, show me what tools are loaded"
Example: "worker ABC, inspect wiki_tools"

### save_tool
Save a tool definition to Wiki.js for sharing across workers.
Args: { tool_name: string, tool_module: string, tool_function: string, description?: string, tags?: string[] }
Example: "worker ABC, save tool my_custom_tool from module mymodule import my_func"
Example: "worker ABC, lưu tool mytool vào wiki"

### load_tools
Load shared tools from Wiki.js into the worker.
Args: { tool_names?: string[] } (loads all if not specified)
Example: "worker ABC, load all shared tools from wiki"
Example: "worker ABC, tải tools từ wiki"

### delete_tool
Delete a shared tool from Wiki.js.
Args: { tool_name: string }
Example: "worker ABC, delete tool old_tool from wiki"

### unknown
Could not parse intent. Include reasoning in error field.
Args: { reason: string }

## Rules
- Extract ticketId from the message if present (e.g., "worker ABC123" → ticketId="ABC123")
- If no ticketId in message, use the target ticketId passed separately
- Return confidence score 0.0-1.0 based on how certain you are
- For Vietnamese messages, still extract the correct command type
- If the message is just conversational ("thanks", "ok", etc.), return unknown with high confidence
- For save_tool, try to extract tool_name, module, and function from natural language

## Output Format
Always respond with valid JSON:
{
  "type": "register_tool|unregister_tool|update_config|set_system_prompt|reload_role|inspect|unknown",
  "args": { ... },
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}`;

  const userPrompt = `Admin message: "${message}"
Target ticketId: ${ticketId}
Sender: ${sender}

Parse this message and respond with JSON only (no markdown, no explanation).`;

  try {
    let response: any;

    if (llmProvider === 'openai' || llmProvider === 'minimax' || baseUrl.includes('openai')) {
      response = await fetchOpenAI(systemPrompt, userPrompt, apiKey, baseUrl, model);
    } else if (llmProvider === 'anthropic') {
      response = await fetchAnthropic(systemPrompt, userPrompt, apiKey, model);
    } else {
      // Generic OpenAI-compatible
      response = await fetchOpenAI(systemPrompt, userPrompt, apiKey, baseUrl, model);
    }

    const parsed = typeof response === 'string' ? JSON.parse(response) : response;

    return {
      command: {
        type: parsed.type || 'unknown',
        args: parsed.args || {},
        raw: message,
        confidence: parsed.confidence || 0.5,
      },
    };
  } catch (error: any) {
    console.error('[IntentParser] LLM call failed:', error.message);
    return {
      command: {
        type: 'unknown',
        args: { reason: `Parse error: ${error.message}` },
        raw: message,
        confidence: 0,
      },
    };
  }
}

async function fetchOpenAI(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  baseUrl: string,
  model: string
): Promise<any> {
  const url = `${baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content?.trim() || '';
  
  // Try to extract JSON from the response
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  return { type: 'unknown', args: { reason: 'No JSON in response' }, confidence: 0 };
}

async function fetchAnthropic(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  model: string
): Promise<any> {
  const url = 'https://api.anthropic.com/v1/messages';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-3-5-sonnet-20241022',
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      temperature: 0.1,
      max_tokens: 500,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

const data = await response.json() as { content?: { text?: string }[] };
  const content = data.content?.[0]?.text?.trim() || '';
  
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  return { type: 'unknown', args: { reason: 'No JSON in response' }, confidence: 0 };
}

/**
 * Check if a message is directed at a worker (contains "worker {ticketId}" pattern)
 * or is a conversational message not requiring parsing
 */
export function isWorkerDirectedMessage(message: string): { isDirected: boolean; ticketId?: string } {
  // Patterns that indicate a worker-directed command
  const workerPatterns = [
    /worker\s+([A-Za-z0-9_-]+)/i,
    /ticket\s+([A-Za-z0-9_-]+)/i,
    /([A-Za-z0-9_-]{6,})\s*[,:]\s*/i, // Generic ID followed by comma/colon
  ];

  const lowerMsg = message.toLowerCase().trim();

  // Skip conversational messages
  const conversational = ['thanks', 'thank you', 'ok', 'okay', 'yes', 'no', 'sure', 'got it', '👍', '👍'];
  if (conversational.some(c => lowerMsg === c || lowerMsg.startsWith(c + ' '))) {
    return { isDirected: false };
  }

  for (const pattern of workerPatterns) {
    const match = message.match(pattern);
    if (match) {
      return { isDirected: true, ticketId: match[1] };
    }
  }

  // Default: treat as directed if it contains action words
  const actionWords = ['add', 'remove', 'set', 'update', 'reload', 'show', 'thêm', 'xóa', 'cập nhật', 'tải lại', 'hiển thị'];
  if (actionWords.some(w => lowerMsg.includes(w))) {
    return { isDirected: true };
  }

  return { isDirected: false };
}
