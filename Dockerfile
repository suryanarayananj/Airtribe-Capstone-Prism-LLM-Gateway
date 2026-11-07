# Prism gateway — Node 22 + Fastify + SQLite + local MiniLM embeddings
FROM node:22-bookworm-slim

WORKDIR /app

# Production deps only (includes @xenova/transformers)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY data ./data

# Persistable paths (compose mounts volumes here)
RUN mkdir -p /data /cache/transformers /cache/huggingface \
  && chown -R node:node /app /data /cache

ENV NODE_ENV=production \
    PRISM_HOST=0.0.0.0 \
    PRISM_PORT=8080 \
    PRISM_DB_PATH=/data/prism.db \
    PRISM_UPSTREAM=mock \
    TRANSFORMERS_CACHE=/cache/transformers \
    HF_HOME=/cache/huggingface \
    XDG_CACHE_HOME=/cache

USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
