# Vega H-Sub Providers

Two anime providers for Vega:

- **Anikai H-Sub** — Anikai catalog, search, metadata, and episodes with fast Hard-Sub HLS playback in 480p, 720p, and genuine 1080p. The slow Blogger streams are excluded.
- **Anime H-Sub 1080** — native catalog, search, metadata, episodes, and Hard-Sub playback in 480p, 720p, and 1080p. AnimeGG is used first; missing episodes use the same native Hard-Sub HLS resolver as Anikai. Soft-sub sources are excluded.

The second provider keeps the old `animepaheHSub` identifier so existing installations update in place. It uses JustAnime's native API and Hard-Sub media sources, so it never opens a Cloudflare WebView.

Download quality choices include exact AnimeGG file sizes or clearly marked HLS size estimates such as `~262 MB`. Estimates are calculated from the rendition bitrate and episode duration.

## Build

```sh
npm ci
npm run build
```

The installable bundles are generated in `dist/`. Both provider entries are declared in `manifest.json`.

## Vega settings

- Anikai supports preferred quality, allowed resolutions, and a custom base URL.
- Anime H-Sub 1080 supports preferred quality, allowed resolutions, and an optional JustAnime API mirror.
