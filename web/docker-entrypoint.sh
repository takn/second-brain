#!/bin/sh
# Runs oauth2-proxy (Google SSO gate) in front of the Next.js standalone
# server. Fails closed: missing OAuth config aborts the container instead of
# serving the app unauthenticated.
set -eu

: "${OAUTH2_PROXY_CLIENT_ID:?missing}" \
  "${OAUTH2_PROXY_CLIENT_SECRET:?missing}" \
  "${OAUTH2_PROXY_COOKIE_SECRET:?missing}" \
  "${OAUTH2_PROXY_EMAIL_DOMAINS:?missing}"

# Next standalone binds to $HOSTNAME/$PORT, and App Runner injects
# HOSTNAME=<instance-dns> at runtime — pin it to loopback so the app is only
# reachable through the proxy.
HOSTNAME=127.0.0.1 PORT=3001 node web/server.js &
app=$!

# Identity config (client id/secret, cookie secret, email domains) comes in
# via OAUTH2_PROXY_* env vars from App Runner. --reverse-proxy makes the
# proxy trust X-Forwarded-* headers, from which the OAuth redirect URL is
# inferred — no per-domain config needed here.
oauth2-proxy \
  --provider=google \
  --http-address=0.0.0.0:3000 \
  --upstream=http://127.0.0.1:3001 \
  --reverse-proxy=true \
  --cookie-secure=true \
  --skip-provider-button=true &
proxy=$!

trap 'kill "$app" "$proxy" 2>/dev/null || true' TERM INT

# busybox sh has no `wait -n`: poll both, and exit non-zero if either dies so
# App Runner replaces the instance.
while kill -0 "$app" 2>/dev/null && kill -0 "$proxy" 2>/dev/null; do
  sleep 5
done
kill "$app" "$proxy" 2>/dev/null || true
exit 1
