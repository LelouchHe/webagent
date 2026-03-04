#!/bin/bash
# Load fnm environment to resolve the correct node version
export DATA_DIR=data
export PATH="/opt/homebrew/bin:$PATH"
eval "$(fnm env)"
exec node --experimental-strip-types src/server.ts
