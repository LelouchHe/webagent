import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideBootstrap,
  buildBootstrapUrl,
  formatBootstrapBanner,
} from "../src/bootstrap.ts";

describe("bootstrap.decideBootstrap", () => {
  it("proceeds when tokens already exist (regardless of other flags)", () => {
    for (const isTTY of [true, false]) {
      for (const firstRunEnabled of [true, false]) {
        for (const authJsonExists of [true, false]) {
          assert.deepEqual(
            decideBootstrap({
              authJsonExists,
              tokenCount: 1,
              isTTY,
              firstRunEnabled,
            }),
            { kind: "proceed" },
            `tokens>0 but got non-proceed for ${JSON.stringify({
              authJsonExists,
              isTTY,
              firstRunEnabled,
            })}`,
          );
        }
      }
    }
  });

  it("mints when auth.json missing + isTTY + firstRunEnabled + 0 tokens", () => {
    assert.deepEqual(
      decideBootstrap({
        authJsonExists: false,
        tokenCount: 0,
        isTTY: true,
        firstRunEnabled: true,
      }),
      { kind: "mint" },
    );
  });

  it("exits-config when auth.json file exists but list is empty", () => {
    // 文件存在但 0 token = 配置异常(被手动清空 / 解析失败 / 权限错),
    // 不该静默重新签 admin token。
    assert.deepEqual(
      decideBootstrap({
        authJsonExists: true,
        tokenCount: 0,
        isTTY: true,
        firstRunEnabled: true,
      }),
      { kind: "exit-config" },
    );
  });

  it("exits-config when non-TTY (daemon mode) — fall back to --create-token UX", () => {
    assert.deepEqual(
      decideBootstrap({
        authJsonExists: false,
        tokenCount: 0,
        isTTY: false,
        firstRunEnabled: true,
      }),
      { kind: "exit-config" },
    );
  });

  it("exits-config when first_run_bootstrap is disabled in config", () => {
    assert.deepEqual(
      decideBootstrap({
        authJsonExists: false,
        tokenCount: 0,
        isTTY: true,
        firstRunEnabled: false,
      }),
      { kind: "exit-config" },
    );
  });
});

describe("bootstrap.buildBootstrapUrl", () => {
  it("places token only in URL fragment, not path or query", () => {
    const url = buildBootstrapUrl(6800, "wat_abc123");
    assert.equal(url, "http://localhost:6800/#t=wat_abc123");
    const u = new URL(url);
    assert.equal(u.search, "");
    assert.equal(u.pathname, "/");
    assert.equal(u.hash, "#t=wat_abc123");
  });

  it("respects custom port", () => {
    assert.equal(
      buildBootstrapUrl(8080, "wat_xyz"),
      "http://localhost:8080/#t=wat_xyz",
    );
  });
});

describe("bootstrap.formatBootstrapBanner", () => {
  const url = "http://localhost:6800/#t=wat_xx";

  it("plain text (no ANSI) when isTTY=false", () => {
    const out = formatBootstrapBanner({ url, isTTY: false });
    assert.match(out, /http:\/\/localhost:6800\/#t=wat_xx/);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\u001b\[/, "should not contain ANSI escapes");
  });

  it("includes ANSI escapes when isTTY=true", () => {
    const out = formatBootstrapBanner({ url, isTTY: true });
    // eslint-disable-next-line no-control-regex
    assert.match(out, /\u001b\[/);
    assert.match(out, /http:\/\/localhost:6800\/#t=wat_xx/);
  });

  it("mentions URL fragment safety so operators understand why it's safe-ish", () => {
    const out = formatBootstrapBanner({ url, isTTY: false });
    assert.match(
      out,
      /fragment|after `#`|never sent|not.*server/i,
      "banner should explain the # property",
    );
  });
});
