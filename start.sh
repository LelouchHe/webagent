#!/bin/bash
# Load fnm environment to resolve the correct node version
export PATH="/opt/homebrew/bin:$PATH"
eval "$(fnm env)"
node scripts/build.js
exec node --experimental-strip-types src/server.ts --config config.toml
