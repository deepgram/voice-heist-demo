# ---------- Stage 1: build the Vite client into ./dist ----------
FROM node:20-slim AS client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY client ./client
RUN npm run build   # vite outputs to /app/dist

# ---------- Stage 2: Python brain that serves the built client ----------
FROM python:3.12-slim AS runtime
WORKDIR /app

COPY brain/requirements.txt ./brain/requirements.txt
RUN pip install --no-cache-dir -r brain/requirements.txt

# Litestream: offsite SQLite replication. Installed always; dormant unless the
# LITESTREAM_REPLICA_URL secret is set (see entrypoint.sh).
ADD https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.deb /tmp/litestream.deb
RUN dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb

COPY brain ./brain
COPY entrypoint.sh ./entrypoint.sh
COPY --from=client /app/dist ./dist

ENV PORT=8080
EXPOSE 8080

# entrypoint.sh starts uvicorn (app.py serves ./dist + /api/* + /ws/brain),
# wrapped in Litestream replication when configured.
# DEEPGRAM_API_KEY comes from a Fly secret (env var), not a .env file.
CMD ["sh", "entrypoint.sh"]
