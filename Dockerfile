FROM node:20-slim AS base

RUN apt-get update && apt-get install -y openssl libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
# Cache mount keeps downloaded packages between builds
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .

RUN npx prisma generate

EXPOSE 5000

# Push schema changes to the DB before starting (safe for additive changes like new columns).
CMD ["sh", "-c", "npx prisma db push && node src/server.js"]
