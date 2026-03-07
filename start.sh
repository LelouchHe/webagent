#!/bin/bash
# Load fnm environment to resolve the correct node version
export DATA_DIR=data
export DEFAULT_CWD="$HOME/mine/space"
export PATH="/opt/homebrew/bin:$PATH"
eval "$(fnm env)"
node scripts/build.js
exec node --experimental-strip-types src/server.ts
