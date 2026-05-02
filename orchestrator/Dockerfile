FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm install

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3000

# Run the built app
CMD ["npm", "start"]