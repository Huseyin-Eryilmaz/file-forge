# Two stages: install and build in one, run in a lean image.
#
# The build stage carries the TypeScript compiler and dev dependencies;
# the runtime stage carries neither. That keeps the shipped image small
# and its attack surface narrower — nothing in production needs tsc.

FROM node:22-slim AS builder

WORKDIR /app

# Copy manifests first and install before copying source. Docker caches
# layers, so this way a source-only change does not reinstall every
# dependency — the slowest step is skipped when it has not changed.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-slim AS runtime

WORKDIR /app

# Production dependencies only.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Run as a non-root user. The node image ships one; using it means a
# container escape does not start with root privileges.
RUN mkdir -p /app/storage && chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/server.js"]
