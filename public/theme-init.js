// Set theme attribute synchronously before stylesheet renders, to avoid FOUC.
// Extracted from inline <script> so a strict CSP `script-src 'self'` works.
document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') || 'auto');
