#!/bin/sh
# Run the daemon in the foreground, start `wmux web` once it answers, and exit
# with the daemon so the container restarts when it dies.
#
# Environment:
#   WMUX_WEB_PORT       port inside the container (default 7681)
#   WMUX_ALLOW_HOST     the proxy's public host name(s), comma-separated
#   WMUX_ALLOW_INPUT    1 (default) lets paired devices type into terminals
#   WMUX_INSTALL_CLAUDE 1 (default) installs Claude Code on first start
#   WMUX_TRUST_PROXY_USER, WMUX_TRUST_PROXY_FROM
#                       both set: admit a request without the wmux token when
#                       it comes from the proxy at _FROM (one IP address) with
#                       X-Auth-Request-Email equal to _USER
set -eu

port="${WMUX_WEB_PORT:-7681}"

if [ "${WMUX_INSTALL_CLAUDE:-1}" = "1" ] && ! command -v claude >/dev/null 2>&1; then
  echo "Installing Claude Code into $HOME/.local (first start only)..."
  curl -fsSL https://claude.ai/install.sh | bash || echo "Claude Code install failed; continuing without it." >&2
fi
# Claude Code hooks, approval gate included, so tool approvals reach the browser.
if command -v claude >/dev/null 2>&1; then
  wmux setup-hooks >/dev/null || echo "wmux setup-hooks failed; remote approvals are off." >&2
fi

wmux daemon run &
daemon=$!
trap 'kill -TERM "$daemon" 2>/dev/null; wait "$daemon"; exit 0' TERM INT

tries=0
until wmux daemon status >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ] || ! kill -0 "$daemon" 2>/dev/null; then
    echo "wmux daemon did not come up." >&2
    exit 1
  fi
  sleep 1
done

set -- web --expose --port "$port"
[ "${WMUX_ALLOW_INPUT:-1}" = "1" ] && set -- "$@" --allow-input
if [ -n "${WMUX_ALLOW_HOST:-}" ]; then
  old_ifs=$IFS; IFS=,
  for h in $WMUX_ALLOW_HOST; do set -- "$@" --allow-host "$h"; done
  IFS=$old_ifs
fi
proxy_user="${WMUX_TRUST_PROXY_USER:-}"
proxy_from="${WMUX_TRUST_PROXY_FROM:-}"
trust_proxy=0
if [ -n "$proxy_user" ] && [ -n "$proxy_from" ]; then
  set -- "$@" --trust-proxy-header X-Auth-Request-Email --trust-proxy-user "$proxy_user" --trust-proxy-from "$proxy_from"
  trust_proxy=1
elif [ -n "$proxy_user" ] || [ -n "$proxy_from" ]; then
  echo "Set both WMUX_TRUST_PROXY_USER and WMUX_TRUST_PROXY_FROM to sign in through the proxy; using the token only." >&2
fi
wmux "$@" >/dev/null

# The web UI starts from existing terminals, so a fresh home gets one, and the
# log names the address to open first (the token is the user's own secret).
json() { /opt/wmux/node/bin/node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String($1))}catch{}})"; }
token=$(wmux web --status --json --show-token 2>/dev/null | json "j.token ?? ''" || true)
api() { curl -fsS -H "Authorization: Bearer $token" -H "Origin: http://127.0.0.1:$port" -H 'Content-Type: application/json' "$@"; }
if [ -z "$token" ]; then
  echo "Could not read the wmux token; run 'wmux web --status --show-token' in the container." >&2
else
  count=$(api "http://127.0.0.1:$port/api/sessions" 2>/dev/null | json "j.sessions?.length ?? ''" || true)
  if [ "$count" = "0" ]; then
    api -X POST -d '{"workspaceId":"ws-main","workspaceName":"main"}' "http://127.0.0.1:$port/api/sessions" >/dev/null 2>&1 \
      || echo "Could not create the first terminal." >&2
  elif [ -z "$count" ]; then
    echo "Could not list terminals; skipped creating the first one." >&2
  fi
  if [ "$trust_proxy" = "1" ] && [ -n "${WMUX_ALLOW_HOST:-}" ]; then
    echo "wmux is ready. Open: https://${WMUX_ALLOW_HOST%%,*}/"
  # Sign in first, then open the token address: a token in the URL during
  # sign-in would travel to the identity provider inside the return address.
  elif [ -n "${WMUX_ALLOW_HOST:-}" ]; then
    echo "wmux is ready. After signing in, open: https://${WMUX_ALLOW_HOST%%,*}/?token=$token"
  else
    echo "wmux is ready on port $port. Token: $token"
  fi
fi

wait "$daemon"
