// Ambient declarations for CDN-loaded globals (marked, DOMPurify)
// and browser APIs not in the default lib.

declare const marked: {
  setOptions(options: Record<string, unknown>): void;
  parse(text: string): string;
};

declare const DOMPurify: {
  sanitize(html: string): string;
};
