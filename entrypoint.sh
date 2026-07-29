#!/bin/sh
# Voice Heist container entrypoint.
#
# When the LITESTREAM_REPLICA_URL secret is set (e.g. s3://bucket/voice-heist),
# the server runs under Litestream, which continuously replicates the SQLite DB
# offsite — the volume alone is a single point of failure for a season of
# scores and winner emails. Without the secret this is a plain server start.
#
# Enable offsite replication with:
#   fly secrets set LITESTREAM_REPLICA_URL=s3://<bucket>/voice-heist \
#     LITESTREAM_ACCESS_KEY_ID=... LITESTREAM_SECRET_ACCESS_KEY=...
set -e

CMD="python -m uvicorn app:app --app-dir brain --host 0.0.0.0 --port ${PORT:-8080}"

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  exec litestream replicate -exec "$CMD" "${VH_DB_PATH:-/data/voice-heist.db}" "$LITESTREAM_REPLICA_URL"
fi
exec $CMD
