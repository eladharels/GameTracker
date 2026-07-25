FROM node:18-slim
WORKDIR /app
# Upgrade all OS packages to patch CVEs (gpgv, libgnutls30, libpam, perl-base, etc.)
# then install build tools needed to compile sqlite3 from source.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends sqlite3 python3 make g++ curl && \
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
RUN npm ci --omit=dev && \
    apt-get purge -y linux-libc-dev && \
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