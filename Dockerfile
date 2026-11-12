FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# No npm dependencies: the app uses only Node built-ins.
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# Data directory for the SQLite database (mounted as a volume in compose).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV DB_PATH=/app/data/readings.db

HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "--disable-warning=ExperimentalWarning", "scripts/healthcheck.js"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
