# Build from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:22-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_ENV=production
# poppler-utils gives us pdftoppm: scanned PDFs (an image in a PDF wrapper) are
# rasterized before OCR. First apt layer in this repo — a Debian mirror is now a
# build dependency. Deliberately above the COPY/pnpm install layers so a
# dependency change does not re-run apt.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
# Both apps' manifests must be present or --frozen-lockfile rejects the
# lockfile (it lists every workspace importer, including apps/web).
COPY apps ./apps
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "--filter", "worker", "start"]
