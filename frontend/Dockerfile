# Build stage. Nothing from it reaches production (nginx serves the emitted assets), but
# it must still be a SUPPORTED Node: 20 went EOL 2026-04-30, and swagger-client — which
# ships in the bundle — declares engines >=22. The major must match CI's setup-node and
# package.json's engines floor; test/runtime.test.js enforces both (ROADMAP UP-2).
FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./

# All dependencies (dev included: the build needs Vite), with install scripts OFF.
# Seven packages have one (eight lockfile entries), and none is needed for a browser bundle:
#   - @scarf/scarf is an install-time telemetry beacon that phones home;
#   - tree-sitter and its grammars compile a NATIVE Node binding via node-gyp. The
#     built bundle contains no tree-sitter at all (it parses YAML with js-yaml), so that
#     binding never reached the page; it only built because full `node:20` had a compiler;
#   - core-js-pure prints a banner; esbuild's postinstall only verifies its binary, which
#     comes from the platform optionalDependency either way; fsevents is macOS-only.
# Verified by building with scripts off and loading /api-docs, which parses the YAML spec.
RUN npm ci --ignore-scripts

COPY . .

RUN npm run build

# Production stage — nginx-unprivileged runs as non-root user on port 8080
FROM nginxinc/nginx-unprivileged:alpine

# Take Alpine's security fixes now rather than when upstream next rebuilds the tag —
# a libexpat HIGH sat fixed in the Alpine repos while the base still shipped the old
# package. Root for this one layer only; USER nginx is restored below.
USER root
RUN apk upgrade --no-cache

# Copy built files from build stage
COPY --from=build /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

# Restores the unprivileged user after the root `apk upgrade` layer above — this line,
# not the base image's own USER, is what the container runs as. Semgrep verifies it.
USER nginx
CMD ["nginx", "-g", "daemon off;"]
