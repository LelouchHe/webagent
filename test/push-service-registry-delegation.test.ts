// Plan C Step 3 regression test:
//
// PushService's visibility-read methods must delegate to the injected
// ClientRegistry, not to its own legacy `clients` Map. Locking this down
// guards the source-of-truth invariant: ClientRegistry is authoritative
// for visibility (identity layer), pushService only owns endpoint mapping
// (transport layer).
//
// Each test sets up a deliberate divergence between the two stores —
// registry says VISIBLE, pushService.clients says NOT VISIBLE — and asserts
// the public read method returns the registry's answer.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { PushService } from "../src/push-service.ts";
import { ClientRegistry } from "../src/client-registry.ts";

describe("PushService — visibility reads delegate to ClientRegistry (Plan C Step 3)", () => {
  let store: Store;
  let tmpDir: string;
  let registry: ClientRegistry;
  let svc: PushService;
  let nowMs: number;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-push-step3-"));
    store = new Store(tmpDir);
    nowMs = 1_000_000;
    registry = new ClientRegistry({
      visibilityTtlMs: 60_000,
      now: () => nowMs,
    });
    svc = new PushService(store, tmpDir, "mailto:test@localhost", {
      clientRegistry: registry,
      visibilityTtlMs: 60_000,
      now: () => nowMs,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hasVisibleClient returns true when ONLY registry has the visible client (pushService.clients empty)", () => {
    // pushService.clients has nothing — no updateClient call.
    registry.register("c1", { capabilities: [] });
    registry.setVisibility("c1", { visible: true, active: "sid-A" });

    assert.equal(svc.hasVisibleClient(), true);
  });

  it("hasVisibleClient returns false when registry has no visible client (pushService.clients empty)", () => {
    svc.updateClient("c1", {
      endpoint: "https://push.example/1",
    });
    // Registry — the new source of truth — has nothing.
    assert.equal(svc.hasVisibleClient(), false);
  });

  it("isSessionVisibleToAnyClient reads registry, not pushService.clients", () => {
    registry.register("c1", { capabilities: [] });
    registry.setVisibility("c1", { visible: true, active: "sid-A" });

    assert.equal(svc.isSessionVisibleToAnyClient("sid-A"), true);
    assert.equal(svc.isSessionVisibleToAnyClient("sid-B"), false);
  });

  it("isSessionVisibleToAnyClient still honors the globalVisibilitySuppression kill switch", () => {
    const svcOff = new PushService(store, tmpDir, "mailto:test@localhost", {
      clientRegistry: registry,
      globalVisibilitySuppression: false,
      now: () => nowMs,
    });
    registry.register("c1", { capabilities: [] });
    registry.setVisibility("c1", { visible: true, active: "sid-A" });

    assert.equal(svcOff.isSessionVisibleToAnyClient("sid-A"), false);
  });

  it("isEndpointVisible: registry must say visible AND pushService.clients must own the endpoint", () => {
    // Endpoint↔clientId mapping is push transport state — stays in pushService.
    svc.updateClient("c1", { endpoint: "https://push.example/1" });
    svc.updateClient("c2", { endpoint: "https://push.example/2" });

    registry.register("c1", { capabilities: [] });
    registry.register("c2", { capabilities: [] });
    // Only c1 is visible per registry.
    registry.setVisibility("c1", { visible: true, active: "sid-A" });

    assert.equal(svc.isEndpointVisible("https://push.example/1"), true);
    assert.equal(svc.isEndpointVisible("https://push.example/2"), false);
  });

  it("isEndpointVisible returns false when registry has no visible client, even if pushService.clients owns the endpoint", () => {
    svc.updateClient("c1", {
      endpoint: "https://push.example/1",
    });
    // No registry write → registry says invisible.
    assert.equal(svc.isEndpointVisible("https://push.example/1"), false);
  });

  it("registry TTL expiry flows through pushService reads", () => {
    registry.register("c1", { capabilities: [] });
    registry.setVisibility("c1", { visible: true, active: "sid-A" });
    assert.equal(svc.isSessionVisibleToAnyClient("sid-A"), true);

    // Jump past TTL.
    nowMs += 61_000;
    assert.equal(svc.isSessionVisibleToAnyClient("sid-A"), false);
    assert.equal(svc.hasVisibleClient(), false);
  });
});
