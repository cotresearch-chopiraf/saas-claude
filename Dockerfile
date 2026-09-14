# A1 remediation — single-origin production image: the same Express process
# serves the API (/api/*), /uploads, and the built React SPA (everything
# else), so the client's own relative fetch("/api/...") calls resolve
# correctly with no reverse proxy, CDN rewrite, or separate frontend host
# involved (see app.ts's static/SPA-fallback wiring). Multi-stage: the build
# stage has full devDependencies + TypeScript for both workspaces; the
# runtime stage keeps only production server dependencies plus the two
# compiled/built outputs (server/dist, client/dist) — no client source, no
# devDependencies, no node_modules from the client workspace.

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

# Both workspaces are built for this image now — the server compiles to
# server/dist (tsc), and the client compiles to client/dist (tsc --noEmit +
# vite build), the same production build each already used before this
# change. Reuses the existing package scripts unchanged; no new build step
# was invented.
RUN npm run build --workspace server
RUN npm run build --workspace client

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

# A1 remediation — the built client (static index.html + JS/CSS assets
# only, no source, no node_modules) as a sibling of server/, matching
# app.ts's own process.cwd()-relative resolution (path.resolve(process.cwd(),
# "../client/dist"), the same convention lib/storage/localDiskProvider.ts
# already uses for uploadsDir) — WORKDIR is /app/server at runtime (below),
# so process.cwd() + "../client/dist" resolves to exactly this path.
COPY --from=build /app/client/dist client/dist

# Run as a non-root user, not the image's default root.
RUN addgroup --system app \
  && adduser --system --ingroup app --home /app app \
  && chown -R app:app /app
USER app

WORKDIR /app/server
EXPOSE 4000

# AC-10 — /ready (not /live) on purpose: plain Docker has one health signal,
# not Kubernetes's separate liveness/readiness split, and this repo has no
# Swarm/K8s manifest that would auto-replace an "unhealthy" container on a
# transient DB blip — the real risk that split exists to avoid. What
# actually matters here is docker-compose's `depends_on: condition:
# service_healthy` and any host-level monitoring being able to tell "the
# process is up but the database it needs is unreachable" apart from a
# genuinely working container — exactly what /ready's `select 1` check
# proves and /live (process-only) cannot. No curl/wget is installed in this
# slim image and none is added for this alone — Node 22 has native fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Configuration (DATABASE_URL, JWT_SECRET, PORT, CORS_ORIGIN, and any
# ZATCA_* variables) is supplied entirely at runtime via environment
# variables — nothing is baked into this image, and startupConfig.ts fails
# the process immediately and loudly if a required one is missing. Run
# database migrations as a separate step before starting the server (e.g.
# `docker run <image> node dist/db/migrate.js`), not automatically on
# every container start — see the Slice Z implementation report for why.
CMD ["node", "dist/index.js"]
