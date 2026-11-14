#!/usr/bin/env bash
# Starts the keel server image twice, on SQLite and on Postgres, and checks that /api/health reaches the database.
#   .github/scripts/image-smoke.sh <imagen> [puerto]
# Runs on the architecture of the machine (the release workflow calls it on amd64 and on arm64 runners).
set -euo pipefail

image="$1"
port="${2:-3901}"
run="keel-smoke-$$"
net="$run-net"
env_args=(-e DOKPLOY_URL=https://dokploy.example.com -e DOKPLOY_API_KEY=smoke -e KEEL_ADMIN_PASSWORD=smoke-password-123)

cleanup() {
  docker rm -f "$run-sqlite" "$run-pg" "$run-postgres" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Waits until GET /api/health answers {"ok":true,"db":"ok"}; prints the container's logs if it never does.
wait_healthy() {
  local container="$1" url="http://127.0.0.1:$port/api/health" body=""
  for _ in $(seq 1 60); do
    body="$(curl -fsS "$url" 2>/dev/null || true)"
    if [ "$body" = '{"ok":true,"db":"ok"}' ]; then
      echo "  $container: $body"
      return 0
    fi
    sleep 1
  done
  echo "::error::$container no respondió sano en $url (última respuesta: ${body:-ninguna})" >&2
  docker logs "$container" >&2 || true
  return 1
}

echo "Arquitectura: $(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")"

echo "SQLite…"
docker run -d --name "$run-sqlite" -p "$port:3000" "${env_args[@]}" "$image" >/dev/null
wait_healthy "$run-sqlite"
docker rm -f "$run-sqlite" >/dev/null

echo "Postgres…"
docker network create "$net" >/dev/null
docker run -d --name "$run-postgres" --network "$net" \
  -e POSTGRES_USER=keel -e POSTGRES_PASSWORD=keel -e POSTGRES_DB=keel postgres:17 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$run-postgres" pg_isready -U keel -d keel >/dev/null 2>&1 && break
  sleep 1
done
docker run -d --name "$run-pg" --network "$net" -p "$port:3000" "${env_args[@]}" \
  -e DB_ENGINE=postgres -e POSTGRES_DSN="postgres://keel:keel@$run-postgres:5432/keel" "$image" >/dev/null
wait_healthy "$run-pg"
# keel migrated the schema on start.
docker exec "$run-postgres" psql -U keel -d keel -tAc "SELECT max(version) FROM schema_migrations" |
  sed 's/^/  migraciones aplicadas hasta la versión /'
echo "OK"
