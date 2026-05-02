import dotenv from 'dotenv';

dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000'),
  
  llm: {
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'gpt-4'
  },
  
  plane: {
    apiUrl: process.env.PLANE_API_URL || 'http://plane-api:3000',
    apiKey: process.env.PLANE_API_KEY || '',
    workspaceId: process.env.PLANE_WORKSPACE_ID || ''
  },
  
  revolt: {
    apiUrl: process.env.REVOLT_API_URL || 'http://revolt-api:8080',
    botToken: process.env.REVOLT_BOT_TOKEN || '',
    userId: process.env.REVOLT_USER_ID || ''
  },
  
  docker: {
    host: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
    workerImage: 'turing-worker-base:latest',
    timeoutMinutes: parseInt(process.env.WORKER_TIMEOUT_MINUTES || '15'),
    zombieCheckIntervalMinutes: parseInt(process.env.ZOMBIE_CHECK_INTERVAL_MINUTES || '5')
  }
};