FROM node:18-slim
WORKDIR /app
# Upgrade all OS packages to patch CVEs (gpgv, libgnutls30, libpam, perl-base, etc.).
#
# NO BUILD TOOLCHAIN. This used to install `sqlite3 python3 make g++` because the
# `sqlite3` npm package has no prebuilt NAPI binary for node:18-slim and compiled from
# source via node-gyp — which is also why the layer order was load-bearing enough to be
# documented in CLAUDE.md.
#
# It is no longer a runtime dependency. The migration to Postgres is done, and the only
# file that still requires it is scripts/migrate-sqlite-to-postgres.js, a one-shot that
# has already been run. It now lives in devDependencies, so `npm ci --omit=dev` below
# never sees it and nothing in this image needs a compiler.
#
# `curl` stays: docker-compose.test.yml's backend healthcheck is
# `curl -sf http://localhost:3000/api/health`.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*
# Use npm@10 for a reliable install on Node 18 (npm@11 dropped Node 18 support).
# npm is removed again in the install step below, so it never reaches the runtime image.
RUN npm install -g npm@10
COPY package*.json ./
# `npm ci` (not `npm install`): installs exactly what package-lock.json pins, so the
# image can never contain an unreviewed transitive version that drifted since the
# lockfile was reviewed. Matches what frontend/Dockerfile already does.
# Then strip build-time-only tooling from the RUNTIME image.
# npm itself bundles its own copies of tar / brace-expansion / sigstore etc. under
# /usr/local/lib/node_modules/npm — Trivy scans those and they carry CVEs that app-level
# `overrides` cannot touch. The app runs `node index.js` and never needs npm at runtime,
# so remove npm (and its npm cache) after installing. This also shrinks the image.
#
# `apt-get purge -y linux-libc-dev` USED to be here and has been removed. That package
# was never installed on purpose — it arrived as a dependency of `g++`, and the purge
# existed to strip the kernel headers the compiler dragged in. With the toolchain gone
# nothing pulls it, so the purge failed the build outright:
#     E: Unable to locate package linux-libc-dev
# apt treats purging an absent package as an error, not a no-op. `|| true` would have
# hidden it; deleting the line removes a step that no longer has anything to do.
RUN npm ci --omit=dev && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/* && \
    npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /root/.npm
COPY . .
ENV NODE_ENV=production
# Transfer ownership to the built-in node user before dropping privileges.
# NOTE: the remaining volume-mounted data files (/app/settings.json,
# /app/sent_notifications.json) must also be owned by UID 1000 on the host:
#   chown 1000:1000 /home/docker/gametracker/data/settings.json \
#                   /home/docker/gametracker/data/sent_notifications.json
# The database itself is no longer a mounted file — it lives in Postgres.
#
# The sqlite3 dependency and its build toolchain above are retained solely so
# scripts/migrate-sqlite-to-postgres.js can read the legacy database during
# cutover. Once the migration is done and the rollback window has closed, both
# can be dropped to shrink the image and its CVE surface.
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "index.js"]