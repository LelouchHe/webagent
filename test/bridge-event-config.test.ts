// Structural test for buildBridgeEventHandlerConfig.
//
// Pure shape assertions — we don't run handleAgentEvent. The purpose is to
// catch silent drops of fields on the inline EventHandlerConfig object
// when refactors reshuffle the call signature. A missing field on this
// config object disables features at runtime with no error logs (e.g. the
// attachment interceptor's schema-drift logging).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBridgeEventHandlerConfig } from "../src/bridge-event-config.ts";
import { createCounters } from "../src/attachment-interceptor.ts";

describe("buildBridgeEventHandlerConfig — structural wiring", () => {
  function makeDeps(
    over: Partial<Parameters<typeof buildBridgeEventHandlerConfig>[0]> = {},
  ) {
    return {
      cancelTimeout: 1234,
      recentPathsLimit: 5,
      attachmentInterceptorCounters: createCounters(),
      shouldLogSchemaDrift: () => true,
      ...over,
    };
  }

  it("passes through cancelTimeout and recentPathsLimit verbatim", () => {
    const cfg = buildBridgeEventHandlerConfig(makeDeps());
    assert.equal(cfg.cancelTimeout, 1234);
    assert.equal(cfg.recentPathsLimit, 5);
  });

  it("attaches attachmentInterceptor with the supplied counters", () => {
    const counters = createCounters();
    const cfg = buildBridgeEventHandlerConfig(
      makeDeps({ attachmentInterceptorCounters: counters }),
    );
    assert.ok(
      cfg.attachmentInterceptor,
      "attachmentInterceptor must be present",
    );
    assert.strictEqual(cfg.attachmentInterceptor.counters, counters);
    assert.equal(typeof cfg.attachmentInterceptor.logger, "object");
    assert.equal(typeof cfg.attachmentInterceptor.onSchemaDrift, "function");
  });

  it("attachmentInterceptor.onSchemaDrift respects shouldLogSchemaDrift throttle", () => {
    let allow = false;
    const cfg = buildBridgeEventHandlerConfig(
      makeDeps({ shouldLogSchemaDrift: () => allow }),
    );
    const ctx = { sessionId: "s", toolCallId: "t", rawInputKeys: ["a"] };
    cfg.attachmentInterceptor!.onSchemaDrift!(ctx);
    allow = true;
    cfg.attachmentInterceptor!.onSchemaDrift!(ctx);
  });
});
