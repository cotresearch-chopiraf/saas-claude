# Slice Z — production image for the server (API) only. The client is a
# static Vite build (client/dist/) meant to be served separately (a static
# host / CDN) — this image does not serve it, matching how CORS_ORIGIN /
# corsOrigins.ts already assumes a split-origin deployment. Multi-stage:
# the build stage has full devDependencies + TypeScript; the runtime stage
# keeps only production dependencies and the compiled output.

# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install the full workspace dependency tree (server + client, incl.
# devDependencies) using the same npm workspaces mechanism as local dev —
# copying only the package manifests first keeps this layer cached across
# source-only changes.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm ci

COPY server server
COPY client client

# Only the server needs to be compiled for this image — the client build is
# a separate deployment artifact (see file header comment above).
RUN npm run build --workspace server

# ---- production runtime stage ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production-only dependencies for the server workspace. Run from the repo
# root (not server/) so npm's workspaces mechanism can resolve against the
# real root lockfile — installing from inside server/ alone would not see
# the workspace-level package-lock.json this monorepo actually uses.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev --workspace server --ignore-scripts

# Playwright is a genuine production dependency (server/src/lib/pdf.ts
# renders real quote/invoice PDFs via headless Chromium, not an optional
# dev tool) — it needs its own browser binary, installed here in the final
# image rather than the build stage so the build stage's cache never holds
# a browser download that would just be discarded.
RUN npx playwright install --with-deps chromium

# Compiled server output and the raw .sql migration files migrate.js reads
# at runtime (drizzle-orm's migrator does not read from compiled dist/).
COPY --from=build /app/server/dist server/dist
COPY server/drizzle server/drizzle

# Run as a non-root user, not the image's default root.
RUN addgroup --system app \
  && adduser --system --ingroup app --home /app app \
  && chown -R app:app /app
USER app

WORKDIR /app/server
EXPOSE 4000

# Configuration (DATABASE_URL, JWT_SECRET, PORT, CORS_ORIGIN, and any
# ZATCA_* variables) is supplied entirely at runtime via environment
# variables — nothing is baked into this image, and startupConfig.ts fails
# the process immediately and loudly if a required one is missing. Run
# database migrations as a separate step before starting the server (e.g.
# `docker run <image> node dist/db/migrate.js`), not automatically on
# every container start — see the Slice Z implementation report for why.
CMD ["node", "dist/index.js"]
