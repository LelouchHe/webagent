import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideBootstrap, formatBootstrapBanner } from "../src/bootstrap.ts";

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

describe("bootstrap.formatBootstrapBanner", () => {
  const token = "wat_AbCdEf0123456789";
  const port = 6800;

  it("contains the raw token verbatim (operator pastes it into login form)", () => {
    const out = formatBootstrapBanner({ token, port, isTTY: false });
    assert.ok(
      out.includes(token),
      `banner should print the token verbatim, got: ${out}`,
    );
  });

  it("contains the login URL (host root, no fragment)", () => {
    const out = formatBootstrapBanner({ token, port, isTTY: false });
    assert.match(out, /http:\/\/localhost:6800\/?(?!#)/);
    assert.ok(
      !out.includes("#t="),
      "banner must NOT embed token in URL fragment — operator pastes manually",
    );
  });

  it("plain text (no ANSI) when isTTY=false", () => {
    const out = formatBootstrapBanner({ token, port, isTTY: false });
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(out, /\u001b\[/, "should not contain ANSI escapes");
  });

  it("includes ANSI escapes when isTTY=true", () => {
    const out = formatBootstrapBanner({ token, port, isTTY: true });
    // eslint-disable-next-line no-control-regex
    assert.match(out, /\u001b\[/);
    assert.ok(out.includes(token), "still includes the token under ANSI");
  });

  it("instructs operator how to use the token (paste into login form)", () => {
    const out = formatBootstrapBanner({ token, port, isTTY: false });
    assert.match(
      out,
      /paste|login|copy/i,
      "banner should tell operator what to do with the token",
    );
  });
});
