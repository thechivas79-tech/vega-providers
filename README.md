# Vega H-Sub Providers

Two anime providers for Vega:

- **Anikai H-Sub** — catalog, search, metadata, episodes, and direct Blogger MP4 streams from `anikai.tv`.
- **AnimeGG H-Sub 1080** — native catalog, search, metadata, episodes, and direct H-Sub MP4 streams in 480p, 720p, and 1080p when available. Downloads use a signed proxy URL optimized for saving the MP4.

The second provider keeps the old `animepaheHSub` identifier so existing installations update in place. Version 2 uses JustAnime's native API and AnimeGG media instead of AnimePahe or Kwik, so it never opens a Cloudflare WebView.

Anikai's Blogger host currently supplies 720p and 360p for most episodes. The provider exposes 1080p automatically whenever Anikai supplies Blogger itag 37, but it cannot increase the resolution of a 720p source file.

## Build

```sh
npm ci
npm run build
```

The installable bundles are generated in `dist/`. Both provider entries are declared in `manifest.json`.

## Vega settings

- Anikai supports a custom base URL.
- AnimeGG supports preferred quality, allowed resolutions, and an optional JustAnime API mirror.
