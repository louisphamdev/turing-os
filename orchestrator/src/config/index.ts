import dotenv from 'dotenv';

dotenv.config();

export function llmProviderRequiresApiKey(provider: string): boolean {
  return provider.toLowerCase() !== 'ollama';
}

// Validate required environment variables
function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] || fallback;
  if (!value) {
    console.error(`[Config] FATAL: Missing required environment variable: ${key}`);
    process.exit(1);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? fallback : parsed;
}

const llmProvider = optionalEnv('LLM_PROVIDER', 'openai');
const llmApiKey = optionalEnv('LLM_API_KEY', '');

if (llmProviderRequiresApiKey(llmProvider) && !llmApiKey) {
  console.error('[Config] FATAL: Missing required environment variable: LLM_API_KEY');
  process.exit(1);
}

export const config = {
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  port: optionalInt('PORT', 3001),

  llm: {
    provider: llmProvider,
    apiKey: llmApiKey,
    baseUrl: optionalEnv('LLM_BASE_URL', 'https://api.openai.com/v1'),
    model: optionalEnv('LLM_MODEL', 'gpt-4o'),
  },

  taiga: {
    apiUrl: optionalEnv('TAIGA_API_URL', 'http://taiga-gateway:80/api/v1'),
    authUrl: optionalEnv('TAIGA_AUTH_URL', 'http://taiga-gateway:80/api/v1'),
    apiKey: optionalEnv('TAIGA_API_KEY', ''),
    projectSlug: optionalEnv('TAIGA_PROJECT_SLUG', 'turing-os'),
  },

  matrix: {
    apiUrl: optionalEnv('SYNAPSE_API_URL', 'http://synapse:8008'),
    botToken: optionalEnv('MATRIX_BOT_TOKEN', ''),
    adminUserId: optionalEnv('MATRIX_ADMIN_USER_ID', ''),
  },

  bookstack: {
    url: optionalEnv('BOOKSTACK_URL', 'http://bookstack:80'),
    apiToken: optionalEnv('BOOKSTACK_TOKEN', ''),
  },

  context7: {
    apiKey: optionalEnv('CONTEXT7_API_KEY', ''),
  },

  docker: {
    host: optionalEnv('DOCKER_HOST', '/var/run/docker.sock'),
    workerImage: optionalEnv('WORKER_IMAGE', 'turing-worker-base:latest'),
    networkName: optionalEnv('DOCKER_NETWORK', 'turing-os_turing_network'),
    timeoutMinutes: optionalInt('WORKER_TIMEOUT_MINUTES', 15),
    zombieCheckIntervalMinutes: optionalInt('ZOMBIE_CHECK_INTERVAL_MINUTES', 5),
    maxWorkers: optionalInt('MAX_WORKERS', 5),
    // Worker resource limits per container
    workerRamMb: optionalInt('WORKER_RAM_MB', 512),
    workerCpuCount: optionalInt('WORKER_CPU_COUNT', 1),
  },

  worker: {
    executionMode: optionalEnv('EXECUTION_MODE', 'sequential') as 'sequential' | 'parallel',
    heartbeatIntervalMs: optionalInt('WORKER_HEARTBEAT_INTERVAL_MS', 120000), // 2 min
    stuckThresholdMs: optionalInt('WORKER_STUCK_THRESHOLD_MS', 600000), // 10 min
    // Resource monitoring & auto-scale
    resourceCheckIntervalMs: optionalInt('RESOURCE_CHECK_INTERVAL_MS', 30_000), // 30s
    scaleUpThreshold: optionalInt('SCALE_UP_THRESHOLD', 80),    // % CPU or RAM
    scaleDownThreshold: optionalInt('SCALE_DOWN_THRESHOLD', 20), // % CPU or RAM
    idleTimeoutMinutes: optionalInt('IDLE_TIMEOUT_MINUTES', 5), // minutes idle before scale-down
  },

  github: {
    repo: optionalEnv('GITHUB_REPO', 'louisphamdev/turing-os'),
    issueUrl: optionalEnv('GITHUB_ISSUE_URL', 'https://github.com/louisphamdev/turing-os/issues/new'),
  },

  orchestrator: {
    url: optionalEnv('ORCHESTRATOR_URL', 'http://turing-orchestrator:3001'),
    autoStartRoles: optionalEnv('AUTO_START_ROLES', 'po,pm,hr,doctor').split(',').map(s => s.trim()),
  },
} as const;

// Log config summary on startup (redact secrets)
export function logConfigSummary(): void {
  const llmKeyStatus = config.llm.apiKey
    ? '✓ Set'
    : llmProviderRequiresApiKey(config.llm.provider)
      ? '✗ Missing'
      : '○ Optional';

  console.log('[Config] ═══════════════════════════════════════');
  console.log(`[Config] Environment: ${config.nodeEnv}`);
  console.log(`[Config] Port: ${config.port}`);
  console.log(`[Config] LLM Provider: ${config.llm.provider} (model: ${config.llm.model})`);
  console.log(`[Config] LLM API Key: ${llmKeyStatus}`);
  console.log(`[Config] Taiga: ${config.taiga.apiUrl} (key: ${config.taiga.apiKey ? '✓' : '✗'})`);
  console.log(`[Config] Matrix: ${config.matrix.apiUrl} (token: ${config.matrix.botToken ? '✓' : '✗'})`);
  console.log(`[Config] BookStack: ${config.bookstack.url} (token: ${config.bookstack.apiToken ? '✓' : '✗'})`);
  console.log(`[Config] Context7: ${config.context7.apiKey ? '✓ Set' : '✗ Missing'}`);
  console.log(`[Config] Docker: ${config.docker.workerImage} (max: ${config.docker.maxWorkers})`);
  console.log(`[Config] Execution Mode: ${config.worker.executionMode}`);
  console.log('[Config] ═══════════════════════════════════════');
}