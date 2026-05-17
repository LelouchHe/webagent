// Builds the EventHandlerConfig object passed to handleAgentEvent for every
// bridge event. Lives in its own file so a unit test can lock the wiring
// without booting the full server.
//
// Why this matters: missing fields on the inline config object handed to
// handleAgentEvent are silent at runtime — the affected feature just stops
// working, and the bug only surfaces in dogfood. A small structural test
// next to this builder makes future "merge --theirs" / refactor passes
// fail loudly instead.

import { log } from "./log.ts";
import type { EventHandlerConfig } from "./event-handler.ts";
import type { InterceptorCounters } from "./attachment-interceptor.ts";

export interface BridgeEventConfigDeps {
  cancelTimeout: number;
  recentPathsLimit: number;
  attachmentInterceptorCounters: InterceptorCounters;
  shouldLogSchemaDrift: () => boolean;
}

export function buildBridgeEventHandlerConfig(
  deps: BridgeEventConfigDeps,
): EventHandlerConfig {
  return {
    cancelTimeout: deps.cancelTimeout,
    recentPathsLimit: deps.recentPathsLimit,
    attachmentInterceptor: {
      counters: deps.attachmentInterceptorCounters,
      logger: log.scope("attachment-interceptor"),
      onSchemaDrift: (ctx) => {
        if (!deps.shouldLogSchemaDrift()) return;
        log
          .scope("attachment-interceptor")
          .error("schema drift detected — rawInput has no known path key", {
            ctx,
          });
      },
    },
  };
}
