# NanoClaw Receipt Agent
# Lightweight receipt extraction using Haiku

FROM node:22-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm install

# Copy source and build
COPY src ./src
COPY tsconfig.json ./
RUN npm run build

# Clean up dev dependencies for smaller image
RUN npm prune --production

# Run as non-root
RUN chown -R node:node /app
USER node

# Input: JSON via stdin with base64 image
# Output: JSON via stdout with extraction result
ENTRYPOINT ["node", "dist/index.js"]
