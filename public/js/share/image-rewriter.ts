// Image-src rewriter for the share viewer.
//
// Extracted from viewer.ts so it can be unit-tested without importing the
// viewer's top-level `void main()`, which boots against the live DOM and
// `location`. The rewriter itself is a pure function over strings.

export function makeImageRewriter(token: string): (src: string) => string {
  // Match `/api/v1/sessions/<sid>/images/<file>` with an optional query string.
  // The main app stores user_message images with a signed query
  // (`?sig=…&exp=…`) — see public/js/input.ts where the upload response's
  // `url` is written to the event's `path` field. Without the optional
  // `(?:\?.*)?` tail this regex silently misses signed URLs and viewers see
  // broken `<img src>` pointing at the authenticated owner-side endpoint.
  const re = /^\/api\/v1\/sessions\/[^/]+\/images\/([A-Za-z0-9._-]+)(?:\?.*)?$/;
  return (src: string): string => {
    const m = re.exec(src);
    if (m) return `/s/${encodeURIComponent(token)}/images/${m[1]}`;
    return src;
  };
}
