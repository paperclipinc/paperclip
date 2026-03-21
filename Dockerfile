# ── Stage 1: base ─────────────────────────────────────────────
FROM node:22-trixie-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# ── Stage 2: deps ─────────────────────────────────────────────
# Install all dependencies (dev + prod) using lockfile.
# This layer is cached unless a package.json or lockfile changes.
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY desktop/package.json desktop/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY packages/plugins/create-paperclip-plugin/package.json packages/plugins/create-paperclip-plugin/
COPY packages/plugins/examples/plugin-authoring-smoke-example/package.json packages/plugins/examples/plugin-authoring-smoke-example/
COPY packages/plugins/examples/plugin-file-browser-example/package.json packages/plugins/examples/plugin-file-browser-example/
COPY packages/plugins/examples/plugin-hello-world-example/package.json packages/plugins/examples/plugin-hello-world-example/
COPY packages/plugins/examples/plugin-kitchen-sink-example/package.json packages/plugins/examples/plugin-kitchen-sink-example/

RUN pnpm install --frozen-lockfile

# ── Stage 3: build ────────────────────────────────────────────
FROM base AS build
WORKDIR /app

COPY --from=deps /app /app
COPY . .

RUN pnpm -r build \
  && test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

# Re-install with prod-only deps for a clean node_modules
RUN rm -rf node_modules */node_modules packages/*/node_modules packages/adapters/*/node_modules packages/plugins/*/node_modules packages/plugins/examples/*/node_modules \
  && pnpm install --frozen-lockfile --prod --ignore-scripts

# ── Stage 4: production ───────────────────────────────────────
# Distroless-style minimal image. No shell, no package manager,
# no build tools — only the Node runtime and built artifacts.
FROM node:22-trixie-slim AS production

LABEL org.opencontainers.image.source="https://github.com/paperclipinc/paperclip"
LABEL org.opencontainers.image.description="Paperclip — AI company orchestration platform"
LABEL org.opencontainers.image.vendor="Paperclip Inc."
LABEL org.opencontainers.image.licenses="MIT"

# Minimal runtime deps: tini for PID 1, curl for healthcheck, git for agent runtimes
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini curl git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && apt-get purge -y --auto-remove -o APT::AutoRemove::RecommendsImportant=false

RUN corepack enable

# Agent runtimes — pinned versions for reproducibility
RUN npm install --global --omit=dev \
    @anthropic-ai/claude-code@latest \
    @openai/codex@latest \
    opencode-ai \
  && npm cache clean --force \
  && rm -rf /tmp/*

RUN mkdir -p /paperclip && chown node:node /paperclip

WORKDIR /app

# Copy only production node_modules (rebuilt as prod-only in build stage)
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json /app/pnpm-workspace.yaml /app/.npmrc ./

# Server: only compiled output + runtime deps
COPY --chown=node:node --from=build /app/server/dist ./server/dist
COPY --chown=node:node --from=build /app/server/package.json ./server/
COPY --chown=node:node --from=build /app/server/node_modules ./server/node_modules

# UI: only built static files
COPY --chown=node:node --from=build /app/ui/dist ./ui/dist

# Shared packages: only dist output
COPY --chown=node:node --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node --from=build /app/packages/shared/package.json ./packages/shared/
COPY --chown=node:node --from=build /app/packages/db/dist ./packages/db/dist
COPY --chown=node:node --from=build /app/packages/db/package.json ./packages/db/
COPY --chown=node:node --from=build /app/packages/adapter-utils/dist ./packages/adapter-utils/dist
COPY --chown=node:node --from=build /app/packages/adapter-utils/package.json ./packages/adapter-utils/
COPY --chown=node:node --from=build /app/packages/plugins/sdk/dist ./packages/plugins/sdk/dist
COPY --chown=node:node --from=build /app/packages/plugins/sdk/package.json ./packages/plugins/sdk/

# Adapters: only dist output
COPY --chown=node:node --from=build /app/packages/adapters/claude-local/dist ./packages/adapters/claude-local/dist
COPY --chown=node:node --from=build /app/packages/adapters/claude-local/package.json ./packages/adapters/claude-local/
COPY --chown=node:node --from=build /app/packages/adapters/codex-local/dist ./packages/adapters/codex-local/dist
COPY --chown=node:node --from=build /app/packages/adapters/codex-local/package.json ./packages/adapters/codex-local/
COPY --chown=node:node --from=build /app/packages/adapters/cursor-local/dist ./packages/adapters/cursor-local/dist
COPY --chown=node:node --from=build /app/packages/adapters/cursor-local/package.json ./packages/adapters/cursor-local/
COPY --chown=node:node --from=build /app/packages/adapters/gemini-local/dist ./packages/adapters/gemini-local/dist
COPY --chown=node:node --from=build /app/packages/adapters/gemini-local/package.json ./packages/adapters/gemini-local/
COPY --chown=node:node --from=build /app/packages/adapters/openclaw-gateway/dist ./packages/adapters/openclaw-gateway/dist
COPY --chown=node:node --from=build /app/packages/adapters/openclaw-gateway/package.json ./packages/adapters/openclaw-gateway/
COPY --chown=node:node --from=build /app/packages/adapters/opencode-local/dist ./packages/adapters/opencode-local/dist
COPY --chown=node:node --from=build /app/packages/adapters/opencode-local/package.json ./packages/adapters/opencode-local/
COPY --chown=node:node --from=build /app/packages/adapters/pi-local/dist ./packages/adapters/pi-local/dist
COPY --chown=node:node --from=build /app/packages/adapters/pi-local/package.json ./packages/adapters/pi-local/

# CLI
COPY --chown=node:node --from=build /app/cli/dist ./cli/dist
COPY --chown=node:node --from=build /app/cli/package.json ./cli/

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private

VOLUME ["/paperclip"]
EXPOSE 3100

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3100/api/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
