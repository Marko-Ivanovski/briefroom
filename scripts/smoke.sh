#!/bin/sh
# Builds the production image, starts the compose stack and checks that it works end to end.
# Needs Docker with Compose, curl and Node. Set SMOKE_SKIP_BUILD=1 to reuse an image already built.
set -eu

cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
image="ghcr.io/marko-ivanovski/briefroom:$version"
project="briefroom-smoke-$$"
free_port() {
  node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})"
}
port=$(free_port)
https_port=$(free_port)

export BRIEFROOM_VERSION="$version"
export PORT="$port"
export BRIEFROOM_HTTPS_PORT="$https_port"
export BRIEFROOM_HOST=localhost
export POSTGRES_PASSWORD=$(node -p "require('crypto').randomBytes(16).toString('hex')")
export BETTER_AUTH_SECRET=$(node -p "require('crypto').randomBytes(32).toString('hex')")
export BRIEFROOM_SECRET_KEY=$(node -p "require('crypto').randomBytes(32).toString('hex')")

compose() { docker compose -p "$project" -f docker/compose.yml --profile lan "$@"; }
fail() { echo "SMOKE FAIL: $*" >&2; compose logs --no-color --tail 60 >&2 || true; exit 1; }
ok() { echo "ok - $*"; }

cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ "${SMOKE_SKIP_BUILD:-}" != "1" ]; then
  docker build -f docker/Dockerfile --build-arg "VERSION=$version" -t "$image" . || fail "image build"
fi

compose up -d --wait --wait-timeout 180 db app worker || fail "stack did not become healthy"
ok "stack healthy"

curl -fsS "http://127.0.0.1:$port/api/health" | grep -q '"ok":true' || fail "/api/health"
ok "health answers on the published port"

curl -fsS "http://127.0.0.1:$port/api/version" | grep -q "\"app\":\"$version\"" || fail "/api/version is not $version"
ok "version is $version"

compose logs --no-color app | grep -q 'Briefroom setup code:' || fail "no setup code in the app logs"
ok "setup code logged"

for service in app worker; do
  uid=$(compose exec -T "$service" id -u)
  [ "$uid" != "0" ] || fail "$service runs as root"
  caps=$(compose exec -T "$service" sh -c "grep '^CapEff' /proc/1/status | tr -d '[:space:]'")
  [ "$caps" = "CapEff:0000000000000000" ] || fail "$service has capabilities ($caps)"
done
ok "app and worker run as non-root with no capabilities"

compose exec -T app sh -c '[ "$(id -u)" != 0 ] && tailscale version && tailscaled --version && cloudflared --version' >/dev/null \
  || fail "tunnel binaries do not run as non-root in the app container"
compose exec -T app tailscale version | head -1 | grep -qx '1.104.7' || fail "tailscale is not 1.104.7"
compose exec -T app cloudflared --version | grep -q 'version 2026.11.0' || fail "cloudflared is not 2026.11.0"
ok "tailscale and cloudflared run as non-root in the app container"

compose exec -T app sh -c '! grep -rli testkit /app/apps/web/dist' || fail "web bundle contains testkit code"
ok "web bundle has no testkit"

compose exec -T app sh -c '! grep -q testkit_notes /app/apps/api/dist/*.js /app/apps/worker/dist/*.js' || fail "api or worker bundle contains testkit code"
ok "api and worker bundles have no testkit"

compose exec -T app printenv BRIEFROOM_TRUSTED_PROXIES | grep -q '198.51.100.2' || fail "caddy not trusted"
compose up -d --wait --wait-timeout 120 caddy || fail "caddy did not start"
curl -fsSk "https://localhost:$https_port/api/health" | grep -q '"ok":true' || fail "health through caddy"
ok "caddy proxies https to the app"

signin=$(curl -sSk -o /dev/null -w '%{http_code}' -X POST "https://localhost:$https_port/api/auth/sign-in/email"   -H 'content-type: application/json' --data '{"email":"nobody@example.com","password":"wrong-password"}')
case "$signin" in 400|401) ;; *) fail "sign-in through caddy answered $signin, expected Better Auth's 401 or 400" ;; esac
ok "sign-in POST through caddy reaches Better Auth ($signin)"

# A handshake for a name other than BRIEFROOM_HOST must not get a certificate.
if curl -sSk --resolve "stranger.invalid:$https_port:127.0.0.1" "https://stranger.invalid:$https_port/api/health" >/dev/null 2>&1; then
  fail "caddy served a name other than BRIEFROOM_HOST"
fi
ok "caddy refuses an unknown name"

started=$(date +%s)
compose stop worker || fail "worker did not stop"
elapsed=$(( $(date +%s) - started ))
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$(compose ps -a -q worker)")
[ "$exit_code" = "0" ] || fail "worker exited with $exit_code on SIGTERM (137 means it was killed)"
[ "$elapsed" -lt 35 ] || fail "worker took ${elapsed}s to stop"
compose logs --no-color worker | grep -q 'Worker received SIGTERM' || fail "worker logs show no graceful shutdown"
ok "worker drained on SIGTERM in ${elapsed}s"

echo "smoke passed"
