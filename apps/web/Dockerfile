# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:22-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
# Both apps' manifests must be present or --frozen-lockfile rejects the
# lockfile (it lists every workspace importer, including apps/worker).
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter web build

FROM node:22-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_ENV=production
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo ./
# Warm corepack's pnpm cache so the container never needs network at start.
RUN pnpm --version
EXPOSE 3000
CMD ["pnpm", "--filter", "web", "start"]
