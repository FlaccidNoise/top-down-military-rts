import { defineConfig } from 'vite';

// Relative asset URLs. The default ('/') hardcodes /assets/... into
// index.html, which only resolves when the bundle is served from a domain
// root — it 404s on any subpath host (GitHub Pages project sites,
// s3://bucket/build/, a preview URL under /pr-123/). This is a single-page
// canvas app with no client-side router, so there is no deep-linking case
// that relative paths break.
export default defineConfig({ base: './' });
