# Multi-stage build for optimal image size
FROM node:18-alpine AS build

# Set working directory
WORKDIR /app

# Copy package files for dependency installation
COPY package*.json ./

# Install dependencies with npm ci for faster, reliable, reproducible builds
RUN npm ci --only=production && \
    npm ci --only=development

# Copy source code
COPY . .

# Build TypeScript to JavaScript
RUN npm run build

# Production stage
FROM node:18-alpine AS runtime

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp-client -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from build stage
COPY --from=build /app/dist ./dist

# Copy static files
COPY --from=build /app/src/public ./src/public

# Change ownership to non-root user
RUN chown -R mcp-client:nodejs /app

# Switch to non-root user
USER mcp-client

# Expose port
EXPOSE 5001

# Add labels for metadata
LABEL maintainer="Apify <support@apify.com>"
LABEL description="Model Context Protocol Client"
LABEL version="0.1.0"

# Health check using the /client-info endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "const http = require('http'); const options = { hostname: 'localhost', port: 5001, path: '/client-info', timeout: 5000 }; const req = http.request(options, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1)); req.on('timeout', () => process.exit(1)); req.end();"

# Start the application
CMD ["node", "dist/src/main.js"]