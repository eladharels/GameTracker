FROM node:18-slim
WORKDIR /app

# NO BUILD TOOLCHAIN, same rule as the backend image and for the same reason: every
# dependency here is pure JavaScript, and adding one that is not reinstates hundreds of
# megabytes of compiler on every build. See CLAUDE.md.
#
# `curl` is here only for the healthcheck in docker-compose.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

# npm@10: npm@11 dropped Node 18 support. Removed again below so it never reaches the
# runtime image — this process runs `node server.js` and never needs a package manager.
RUN npm install -g npm@10

COPY package*.json ./

# `npm ci`, not `npm install`: exactly what package-lock.json pins, so the image cannot
# contain a transitive version that drifted since the lockfile was reviewed.
#
# npm bundles its own copies of tar / brace-expansion / sigstore under
# /usr/local/lib/node_modules/npm, which Trivy scans and which carry CVEs that
# app-level overrides cannot reach. Removing npm after installing keeps them out of
# the scanned image and shrinks it.
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
# 0.0.0.0 INSIDE the container. What decides who can reach this is the port publishing
# in docker-compose, which binds to 127.0.0.1 by default — binding to loopback in here
# would make the service unreachable from the Docker network even by the host.
ENV MCP_BIND=0.0.0.0
ENV MCP_PORT=3001

# Unprivileged. This process holds no credentials and needs no writable path — it does
# not read settings.json, does not touch the database, and writes no cache. There is
# deliberately nothing here for it to own.
USER node

EXPOSE 3001
CMD ["node", "server.js"]
