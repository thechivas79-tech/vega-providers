# Vega H-Sub Providers

Two anime providers for Vega:

- **Anikai H-Sub** — catalog, search, metadata, episodes, and direct Blogger MP4 streams from `anikai.tv`.
- **AnimePahe H-Sub** — airing catalog, search, metadata, paginated episodes, and direct Kwik HLS streams. Every result is labeled `H-Sub`.

AnimePahe or Kwik may show a WebView security check. For AnimePahe, tap **Verify you are human**, wait at least ten seconds for the requested page to finish loading, then tap **Done**. The provider saves the resulting clearance session.

## Build

```sh
npm ci
npm run build
```

The installable bundles are generated in `dist/`. Both provider entries are declared in `manifest.json`.

## Vega settings

- Anikai supports a custom base URL.
- AnimePahe supports domain selection, preferred quality, allowed resolutions, and an optional Cloudflare User-Agent.
