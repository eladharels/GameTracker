FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
RUN apt-get update && apt-get install -y sqlite3 python3 make g++ && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"] 