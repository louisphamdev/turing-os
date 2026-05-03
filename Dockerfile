# Turing OS - All-in-One Docker Image
# Multi-stage build for optimal image size

FROM python:3.11-slim AS turing-worker-base

WORKDIR /workspace

# Install worker dependencies - rebuilt at 2026-05-02
COPY base-worker/requirements.txt ./worker-requirements.txt
RUN date && pip install --no-cache-dir --upgrade pip 2>&1 && \
    pip install --no-cache-dir -r worker-requirements.txt 2>&1 || \
    pip install --no-cache-dir -r worker-requirements.txt 2>&1

# Copy worker source
COPY base-worker/src/ ./src/

# Default env - can be overridden at runtime
ENV LLM_PROVIDER=openai
ENV TICKET_ID=undefined
ENV ROLE=default

# ============================================================================
# Orchestrator stage
FROM node:20-alpine AS turing-orchestrator

WORKDIR /app

# Install orchestrator dependencies
COPY orchestrator/package*.json ./
RUN npm install

# Copy orchestrator source
COPY orchestrator/src/ ./src/
COPY orchestrator/tsconfig.json ./

# Build TypeScript
RUN npm run build

# ============================================================================
# Final all-in-one image
FROM python:3.11-slim

WORKDIR /app

# Install Node.js and system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy Python worker from stage 1
COPY --from=turing-worker-base /workspace /workspace

# Re-install Python packages in final image
RUN pip install --no-cache-dir requests>=2.31.0 httpx>=0.26.0 openai>=1.12.0 anthropic>=0.18.0 python-dotenv>=1.0.0

# Copy Node.js orchestrator from stage 2
COPY --from=turing-orchestrator /app /app

# Install orchestrator dependencies in final image
COPY --from=turing-orchestrator /app/node_modules ./node_modules
COPY --from=turing-orchestrator /app/dist ./dist

# Environment variables
ENV LLM_PROVIDER=openai
ENV TICKET_ID=undefined
ENV ROLE=default
ENV NODE_ENV=production

# Expose ports
EXPOSE 3000 3001

# Default command - runs both worker and orchestrator
CMD ["sh", "-c", "cd /app && npm start & python /workspace/src/index.py"]
