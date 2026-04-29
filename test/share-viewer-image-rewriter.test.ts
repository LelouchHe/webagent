// Regression test for the share viewer's image-src rewriter.
//
// Background: the main app's POST /api/v1/sessions/:id/images endpoint returns
// `{ path, url }` where `url` is the signed form `…/attachments/<file>?sig=…&exp=…`.
// public/js/input.ts stores that signed URL on user_message events as the
// image's `path` field — so by the time the share viewer ingests events from
// the JSON API, image paths carry a query string. An earlier rewriter regex
// terminated with `$` after the filename and silently failed to match these
// signed URLs, leaving viewers with broken `<img src>` that pointed at the
// authenticated owner-side endpoint.
//
// This test pins the rewriter contract:
//   1. signed URL → rewritten to `/s/<token>/attachments/<file>` (query stripped)
//   2. unsigned URL → rewritten the same way
//   3. unrelated `src` (data:, http://, relative) → returned unchanged

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAttachmentRewriter } from "../public/js/share/image-rewriter.ts";

test("rewrites signed /api/v1/sessions image URL to viewer proxy", () => {
  const rw = makeAttachmentRewriter("abcdefghijklmnopqrstuvwx");
  const signed =
    "/api/v1/sessions/sess123/attachments/1700000000.png?exp=1700003600&sig=deadbeef";
  assert.equal(
    rw(signed),
    "/s/abcdefghijklmnopqrstuvwx/attachments/1700000000.png",
  );
});

test("rewrites unsigned /api/v1/sessions image URL", () => {
  const rw = makeAttachmentRewriter("abcdefghijklmnopqrstuvwx");
  assert.equal(
    rw("/api/v1/sessions/sess123/attachments/foo.jpg"),
    "/s/abcdefghijklmnopqrstuvwx/attachments/foo.jpg",
  );
});

test("rewrites with sig=…&exp=… ordering as well", () => {
  const rw = makeAttachmentRewriter("abcdefghijklmnopqrstuvwx");
  assert.equal(
    rw("/api/v1/sessions/s/attachments/x.webp?sig=abc&exp=999"),
    "/s/abcdefghijklmnopqrstuvwx/attachments/x.webp",
  );
});

test("leaves unrelated src untouched", () => {
  const rw = makeAttachmentRewriter("abcdefghijklmnopqrstuvwx");
  assert.equal(rw("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(rw("https://example.com/x.png"), "https://example.com/x.png");
  assert.equal(rw("images/sess/foo.png"), "images/sess/foo.png");
});

test("token is URL-encoded in the rewritten path", () => {
  // Tokens are 24-char [A-Za-z0-9_-] in practice; this just guards the
  // contract should an oddly-shaped string ever reach the rewriter.
  const rw = makeAttachmentRewriter("a/b");
  assert.equal(
    rw("/api/v1/sessions/s/attachments/x.png"),
    "/s/a%2Fb/attachments/x.png",
  );
});
