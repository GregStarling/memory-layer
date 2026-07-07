#!/bin/sh
# docker-entrypoint.sh — secure-by-default startup guard for ai-memory-layer.
#
# Refuses to start an HTTP server bound to a non-loopback interface unless an
# API key is configured (MEMORY_API_KEY or MEMORY_API_KEYS) or the operator has
# explicitly opted out (MEMORY_ALLOW_UNAUTHENTICATED=1). This prevents the
# default Docker image (which binds 0.0.0.0) from exposing an unauthenticated
# memory store on a shared network.
#
# The guard only applies to HTTP-serving transports. The `mcp` transport speaks
# over stdio and has no network surface, so it is always permitted.
#
# CRITICAL — the guard must reflect what the server will ACTUALLY do, not just
# the env vars. The server (bin/memory-server.mjs) resolves transport and host
# with the precedence: CLI flag > env var > built-in default. If the guard read
# only the env vars it could disagree with the server: e.g.
# `MEMORY_TRANSPORT=mcp` with a command line that still passes
# `--transport http` — the env says "no HTTP" but the server serves HTTP with no
# key. So the guard parses the SAME command line the server will receive ("$@")
# and lets an explicit `--transport`/`--host` flag override the env var, exactly
# mirroring the server's precedence.
#
# Exit codes:
#   0  guard passed — exec the server
#   78 (EX_CONFIG) guard refused — misconfiguration; see message
#
# This logic is exercised directly by src/__tests__/docker-entrypoint.test.ts,
# which shells out with env combinations and asserts the exit codes below. Keep
# the two in sync.

set -e

# arg_value <flag> <args...> -> echo the value following the first occurrence of
# <flag> in the argument list, or nothing if the flag is absent. Mirrors the
# server's getArg(): the value is the very next token. An explicit empty value
# (`--host ''`) is honored as an empty string, matching the server, so the
# emptiness rules below apply to it too.
arg_value() {
  flag="$1"
  shift
  found=1
  for a in "$@"; do
    if [ "$found" = "0" ]; then
      printf '%s' "$a"
      return 0
    fi
    if [ "$a" = "$flag" ]; then
      found=0
    fi
  done
  return 0
}

# arg_present <flag> <args...> -> return 0 if <flag> appears in the arg list.
arg_present() {
  flag="$1"
  shift
  for a in "$@"; do
    [ "$a" = "$flag" ] && return 0
  done
  return 1
}

# Resolve transport with server precedence: --transport arg > env > default(mcp).
if arg_present --transport "$@"; then
  MEMORY_TRANSPORT="$(arg_value --transport "$@")"
else
  MEMORY_TRANSPORT="${MEMORY_TRANSPORT:-mcp}"
fi

# Resolve host with server precedence: --host arg > env > default(127.0.0.1).
# Use ${MEMORY_HOST-127.0.0.1} (substitute ONLY when unset) not
# ${MEMORY_HOST:-127.0.0.1} (substitutes when unset OR empty). The server uses
# nullish coalescing (?? ), so an UNSET host becomes 127.0.0.1 (loopback, safe)
# while an EMPTY host stays "" and Node binds all interfaces (dangerous). The
# guard must treat empty host as non-loopback so it does not fail open.
if arg_present --host "$@"; then
  MEMORY_HOST="$(arg_value --host "$@")"
else
  MEMORY_HOST="${MEMORY_HOST-127.0.0.1}"
fi

# is_loopback <host> -> exit 0 if the host is a loopback / non-network bind.
# The empty string is NOT loopback: the server treats an empty host as "" and
# binds every interface, so a keyless empty-host HTTP server must be refused.
is_loopback() {
  case "$1" in
    "")
      return 1
      ;;
    localhost | 127.* | ::1 | "[::1]")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# serves_http <transport> -> exit 0 if the transport opens an HTTP listener.
serves_http() {
  case "$1" in
    http | both)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

has_key() {
  [ -n "$MEMORY_API_KEY" ] || [ -n "$MEMORY_API_KEYS" ]
}

if serves_http "$MEMORY_TRANSPORT" && ! is_loopback "$MEMORY_HOST"; then
  if ! has_key && [ "$MEMORY_ALLOW_UNAUTHENTICATED" != "1" ]; then
    cat >&2 <<EOF
ai-memory-layer: refusing to start.

  The server will serve HTTP (transport=$MEMORY_TRANSPORT) on a non-loopback
  host (host="$MEMORY_HOST") with no authentication configured.

  This would expose an unauthenticated memory store to every host that can
  reach this container. Choose one of:

    1. Set MEMORY_API_KEY=<secret>            (single-key mode), or
    2. Set MEMORY_API_KEYS=<key registry>     (per-tenant keys), or
    3. Bind to loopback: MEMORY_HOST=127.0.0.1 (not reachable off-host), or
    4. Explicitly opt out: MEMORY_ALLOW_UNAUTHENTICATED=1
       (only do this behind your own trusted network boundary).
EOF
    exit 78
  fi

  if ! has_key && [ "$MEMORY_ALLOW_UNAUTHENTICATED" = "1" ]; then
    echo "ai-memory-layer: WARNING — serving HTTP on \"${MEMORY_HOST}\" with no API key (MEMORY_ALLOW_UNAUTHENTICATED=1). The memory store is unauthenticated." >&2
  fi
fi

exec "$@"
