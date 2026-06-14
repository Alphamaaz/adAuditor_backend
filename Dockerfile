FROM node:22-slim AS base

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# openssl/libssl for Prisma; the rest are Chromium's runtime deps for
# Puppeteer (PDF report rendering).
RUN apt-get update && apt-get install -y \
    openssl libssl-dev chromium \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
    libxrandr2 xdg-utils \
    && rm -rf /var/lib/apt/lists/*

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
