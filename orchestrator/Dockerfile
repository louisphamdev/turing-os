FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm install

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript then drop devDependencies to slim the runtime image.
RUN npm run build && npm prune --omit=dev

# Orchestrator stays root because it mounts /var/run/docker.sock and needs
# the docker GID, which varies between hosts. Containerization gives the
# isolation; least-privilege is enforced at the engine level via labels.

EXPOSE 3001

CMD ["npm", "start"]