FROM node:18-slim
WORKDIR /app
# Upgrade all OS packages to patch CVEs (gpgv, libgnutls30, libpam, perl-base, etc.)
# then install build tools needed to compile sqlite3 from source.
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends sqlite3 python3 make g++ curl && \
    rm -rf /var/lib/apt/lists/*
# Upgrade npm itself to pull in patched versions of its bundled deps
# (cross-spawn, glob, minimatch, tar in /usr/local/lib/node_modules/npm/).
# npm@11 dropped Node 18 support — pin to the last compatible major (10.x).
RUN npm install -g npm@10
COPY package*.json ./
RUN npm install --production
COPY . .
ENV NODE_ENV=production
# Transfer ownership to the built-in node user before dropping privileges.
# NOTE: volume-mounted data files (/app/gametracker.db etc.) must also be
# owned by UID 1000 on the host. Run once after first deploy:
#   chown -R 1000:1000 /home/docker/gametracker/data/
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "index.js"]
