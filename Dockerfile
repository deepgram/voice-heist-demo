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

COPY brain ./brain
COPY --from=client /app/dist ./dist

ENV PORT=8080
EXPOSE 8080

# app.py serves ./dist (static client) + /api/deepgram-token + /ws/brain.
# DEEPGRAM_API_KEY comes from a Fly secret (env var), not a .env file.
CMD ["sh", "-c", "python -m uvicorn app:app --app-dir brain --host 0.0.0.0 --port ${PORT:-8080}"]
