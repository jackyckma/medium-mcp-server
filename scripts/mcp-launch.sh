#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
    printf '%s\n' '{"error":"missing_command","hint":"Pass the node executable and MCP entry point"}' >&2
    exit 2
fi

# Preserve MCP stderr even when the installed xvfb-run merges fd 2 into fd 1.
exec 3>&2
exec /usr/bin/xvfb-run -a --server-args='-screen 0 1280x900x24' \
    /bin/sh -c 'exec "$@" 2>&3 3>&-' medium-mcp "$@"
