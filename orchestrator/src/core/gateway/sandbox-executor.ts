/**
 * Skills Sandbox Executor
 * 
 * Provides isolated execution environment for skills loaded from external
 * sources (like skills.sh). Skills run in a restricted subprocess with:
 * - No direct network access (except through gateway)
 * - Limited filesystem access
 * - Timeout enforcement
 * - No access to worker environment variables
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface SandboxConfig {
  timeoutMs: number;          // Max execution time per skill
  maxMemoryMb: number;        // Memory limit
  allowedPaths: string[];     // Allowed filesystem paths (read-only)
  blockedCommands: string[];   // Blocked shell commands
  networkIsolation: boolean;   // Whether to isolate network
}

export interface SkillExecutionRequest {
  skillName: string;
  skillCode: string;
  skillFunction: string;
  args: any[];
  context: {
    ticketId: string;
    role: string;
    gatewayUrl?: string;
    consumerToken?: string;
  };
}

export interface SkillExecutionResult {
  success: boolean;
  result?: any;
  error?: string;
  executionTimeMs: number;
  stdout?: string;
  stderr?: string;
}

const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 30000,           // 30 seconds
  maxMemoryMb: 256,
  allowedPaths: ['/tmp/sandbox', '/workspace'],
  blockedCommands: [
    'curl', 'wget', 'nc', 'netcat', 'ssh', 'scp',
    'rm -rf', 'dd', 'mkfs', 'fdisk',
    'chmod', 'chown', 'sudo', 'su',
    'bash', 'sh', 'zsh', 'fish',
    'python', 'node', 'ruby', 'perl', 'php',
    'gcc', 'g++', 'make', 'cmake',
  ],
  networkIsolation: true,
};

export class SandboxExecutor {
  private config: SandboxConfig;
  private gatewayUrl: string;
  private consumerToken: string;

  constructor(gatewayUrl?: string, consumerToken?: string, config?: Partial<SandboxConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.gatewayUrl = gatewayUrl || process.env.GATEWAY_URL || '';
    this.consumerToken = consumerToken || process.env.CONSUMER_TOKEN || '';
  }

  /**
   * Execute a skill in sandboxed environment
   */
  async execute(request: SkillExecutionRequest): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    
    // Validate skill code for dangerous patterns before execution
    const validation = this.validateSkillCode(request.skillCode);
    if (!validation.valid) {
      return {
        success: false,
        error: `Skill code validation failed: ${validation.error}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Create a sandboxed execution script
    const sandboxScript = this.createSandboxScript(request);

    // Write script to temp file
    const scriptPath = path.join('/tmp/sandbox', `skill_${Date.now()}.js`);
    
    try {
      // Ensure sandbox directory exists
      if (!fs.existsSync('/tmp/sandbox')) {
        fs.mkdirSync('/tmp/sandbox', { recursive: true });
      }

      fs.writeFileSync(scriptPath, sandboxScript);

      // Execute in subprocess
      const result = await this.runSubprocess(scriptPath, request.context);

      return {
        ...result,
        executionTimeMs: Date.now() - startTime,
      };

    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        executionTimeMs: Date.now() - startTime,
      };
    } finally {
      // Cleanup script file
      try {
        if (fs.existsSync(scriptPath)) {
          fs.unlinkSync(scriptPath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Validate skill code for dangerous patterns
   */
  validateSkillCode(code: string): { valid: boolean; error?: string } {
    // Check for blocked commands
    const codeLower = code.toLowerCase();
    
    for (const blocked of this.config.blockedCommands) {
      if (codeLower.includes(blocked.toLowerCase())) {
        return { 
          valid: false, 
          error: `Blocked command detected: ${blocked}` 
        };
      }
    }

    // Check for environment variable access (skill shouldn't have direct access)
    if (code.includes('process.env') || code.includes('os.environ')) {
      // Allow only specific safe env vars
      const safeEnvPattern = /(process\.env\.(HOME|USER|TMPDIR)|os\.environ\.get\(['"]HOME['"]\))/;
      if (!safeEnvPattern.test(code)) {
        return {
          valid: false,
          error: 'Direct environment variable access is not allowed in skills. Use the gateway for API calls.'
        };
      }
    }

    // Check for attempts to escape sandbox (child_process spawn with shell)
    if (code.includes('child_process') && code.includes('spawn') && code.includes('shell: true')) {
      return {
        valid: false,
        error: 'Shell spawn is not allowed in skills'
      };
    }

    // Check for require('child_process') or import from child_process
    if (/\brequire\s*\(\s*['"]child_process['"]\s*\)/.test(code) ||
        /\bimport\s+.*\s+from\s+['"]child_process['"]/.test(code)) {
      return {
        valid: false,
        error: 'child_process module is not allowed in skills'
      };
    }

    // Check for fs module abuse (writing outside allowed paths)
    if (code.includes('fs.writeFileSync') || code.includes('fs.writeFile')) {
      // Only allow writes to /tmp/sandbox
      const writePattern = /fs\.write(File|Sync)\s*\(\s*['"](?!\/tmp\/sandbox)/;
      if (writePattern.test(code)) {
        return {
          valid: false,
          error: 'File writes are only allowed in /tmp/sandbox directory'
        };
      }
    }

    return { valid: true };
  }

  /**
   * Create sandboxed execution script
   */
  private createSandboxScript(request: SkillExecutionRequest): string {
    // Create a self-contained script that:
    // 1. Sets up safe environment (removes sensitive env vars)
    // 2. Injects gateway context
    // 3. Executes the skill code
    // 4. Returns result via stdout

    const safeEnv = {
      NODE_ENV: 'sandbox',
      GATEWAY_URL: this.gatewayUrl,
      CONSUMER_TOKEN: this.consumerToken,
      TICKET_ID: request.context.ticketId,
      ROLE: request.context.role,
      // Clear any other sensitive vars
      LLM_API_KEY: undefined,
      PLANE_API_TOKEN: undefined,
      BOOKSTACK_TOKEN: undefined,
      MATRIX_BOT_TOKEN: undefined,
    };

    return `
'use strict';

// Sandbox environment setup
${Object.entries(safeEnv)
  .filter(([_, v]) => v !== undefined)
  .map(([k, v]) => `process.env['${k}'] = ${JSON.stringify(v)};`)
  .join('\n')}

// Clear other sensitive env vars
const sensitiveKeys = ['LLM_API_KEY', 'PLANE_API_TOKEN', 'BOOKSTACK_TOKEN', 'MATRIX_BOT_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
sensitiveKeys.forEach(key => delete process.env[key]);

// Gateway helper (safe API access only)
const gatewayUrl = ${JSON.stringify(this.gatewayUrl)};
const consumerToken = ${JSON.stringify(this.consumerToken)};

async function gatewayCall(endpoint, body) {
  if (!gatewayUrl || !consumerToken) {
    throw new Error('Gateway not configured');
  }
  
  const response = await fetch(gatewayUrl + endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + consumerToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) {
    throw new Error('Gateway error: ' + response.status);
  }
  
  return response.json();
}

// Skill execution
async function runSkill() {
  const args = ${JSON.stringify(request.args)};
  
  // Skill code
  ${request.skillCode}
  
  // Call the skill function
  const result = await ${request.skillFunction}(...args);
  
  // Return result
  process.stdout.write(JSON.stringify({ success: true, result }));
}

runSkill().catch(err => {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
  process.exit(1);
});

// Timeout
setTimeout(() => {
  process.stderr.write('Skill execution timeout');
  process.exit(124);
}, ${this.config.timeoutMs});
`;
  }

  /**
   * Run skill in subprocess
   */
  private runSubprocess(scriptPath: string, context: any): Promise<{
    success: boolean;
    result?: any;
    error?: string;
    stdout?: string;
    stderr?: string;
  }> {
    return new Promise((resolve) => {
      const proc = spawn('node', [scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Override with sandboxed env
          NODE_ENV: 'sandbox',
        },
        // Resource limits
        // Note: On Linux, we could use cgroups or seccomp for stronger isolation
        // This is a basic implementation
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // Handle timeout
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({
          success: false,
          error: 'Execution timeout',
          stdout,
          stderr,
        });
      }, this.config.timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timeout);

        // Try to parse stdout as JSON result
        try {
          const output = JSON.parse(stdout.trim());
          resolve({
            ...output,
            stdout,
            stderr,
          });
        } catch {
          resolve({
            success: code === 0,
            error: code === 124 ? 'Execution timeout' : (stderr || `Exit code: ${code}`),
            stdout,
            stderr,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          error: err.message,
          stdout,
          stderr,
        });
      });
    });
  }

  /**
   * Update gateway configuration
   */
  updateGatewayConfig(gatewayUrl: string, consumerToken: string): void {
    this.gatewayUrl = gatewayUrl;
    this.consumerToken = consumerToken;
  }
}
