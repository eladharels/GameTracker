# Node.js 20 LTS build stage (Vite 6 and Vitest 4 both support ^20). Nothing from this
# stage reaches production: nginx serves the emitted assets
FROM node:20 AS build

WORKDIR /app

COPY package*.json ./

# Install dependencies (including dev dependencies needed for build)
RUN npm ci

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
