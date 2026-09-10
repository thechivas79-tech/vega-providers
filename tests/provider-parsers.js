const assert = require("node:assert/strict");
const cheerio = require("cheerio");

const anikaiStream = require("../dist/anikaiHSub/stream.js");
const nativePosts = require("../dist/animepaheHSub/posts.js");
const nativeEpisodes = require("../dist/animepaheHSub/episodes.js");
const nativeStream = require("../dist/animepaheHSub/stream.js");

if (typeof global.atob !== "function") {
  global.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

function makeKvStore() {
  const values = new Map();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => values.delete(key),
    keys: async () => [...values.keys()],
    clear: async () => values.clear(),
  };
}

function hardSubFixture(url) {
  if (url.includes("anineko.to/browser")) {
    return `<article class="nv-anime-card"><h3 class="nv-anime-title"><a href="/watch/one-piece">One Piece</a></h3></article>`;
  }
  if (url === "https://anineko.to/watch/one-piece") {
    return `<article class="nv-info-episode-item"><a class="nv-info-episode-main" href="/watch/one-piece/ep-2"><strong>Episode 2</strong></a></article><article class="nv-info-episode-item"><a class="nv-info-episode-main" href="/watch/one-piece/ep-1177"><strong>Episode 1177</strong></a></article>`;
  }
  if (
    url === "https://anineko.to/watch/one-piece/ep-2" ||
    url === "https://anineko.to/watch/one-piece/ep-1177"
  ) {
    return `<div class="nv-server-panel" data-id="hsub"><button class="nv-server-btn" data-video="https://otakuhg.site/e/hard-one-piece">StreamHG <span>Hard Sub</span></button></div><div class="nv-server-panel" data-id="sub"><button class="nv-server-btn" data-video="https://bibiemb.xyz/soft-one-piece?sub=english.vtt">HD-2 <span>Soft Sub</span></button></div>`;
  }
  if (url === "https://otakuhg.site/d/hard-one-piece") {
    return `<a class="downloadv-item"><small>1920x1080 800.5 MB</small></a><a class="downloadv-item"><small>1280x720 410.2 MB</small></a><a class="downloadv-item"><small>640x360 175.4 MB</small></a>`;
  }
  if (url === "https://otakuhg.site/e/hard-one-piece") {
    return `const src = "https://cdn.example/hard/master.m3u8";`;
  }
  if (url === "https://cdn.example/hard/master.m3u8") {
    return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080
1080.m3u8`;
  }
  if (url === "https://cdn.example/hard/360.m3u8") {
    return `#EXTM3U
#EXTINF:600,
segment-1.ts
#EXTINF:600,
segment-2.ts`;
  }
  return undefined;
}

async function testAnikaiUsesFast1080HardSubsWithoutBlogger() {
  const seen = [];
  const providerContext = {
    commonHeaders: { "User-Agent": "Vega/1.0 (Android)" },
    cheerio,
    kvStore: makeKvStore(),
    axios: {
      get: async (url, config) => {
        seen.push([url, config.headers["User-Agent"]]);
        const fixture = hardSubFixture(url);
        if (fixture !== undefined) return { data: fixture };
        if (url.includes("anikai.tv")) {
          return {
            data: `<h1 class="entry-title">One Piece Episode 1177 English Subbed</h1><iframe src="https://www.blogger.com/video.g?token=slow"></iframe>`,
          };
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    },
  };
  const streams = await anikaiStream.getStream({
    link: "https://anikai.tv/one-piece-episode-1177-english-subbed/",
    type: "series",
    providerContext,
    isDownload: true,
  });
  assert.deepEqual(streams.map((stream) => stream.quality), [
    "1080",
    "720",
    "360",
  ]);
  assert.match(streams[0].server, /800\.5 MB/);
  assert.equal(streams[0].tag, "H-Sub");
  assert.equal(streams[0].subtitles, undefined);
  assert.equal(seen.some(([url]) => url.includes("blogger.com")), false);
  assert.deepEqual(
    [...new Set(seen.map(([, agent]) => agent))],
    ["Vega/1.0 (Android)"],
  );
}

function makeNativeContext(handler) {
  let webViewCalls = 0;
  const context = {
    commonHeaders: { "User-Agent": "Vega test" },
    cheerio,
    kvStore: makeKvStore(),
    axios: {
      get: async (url, config) => handler(url, config),
    },
    openWebView: async () => {
      webViewCalls += 1;
      throw new Error("WebView must never open");
    },
  };
  return { context, webViewCalls: () => webViewCalls };
}

async function testNativeCatalogUsesAllowedOriginWithoutWebView() {
  const seen = [];
  const native = makeNativeContext(async (url, config) => {
    seen.push({ url, headers: config.headers });
    return {
      data: {
        latestEpisode: [
          {
            id: 21,
            title: { english: "ONE PIECE" },
            cover: "https://example.com/one-piece.jpg",
            latestEpisode: 1177,
          },
        ],
      },
    };
  });
  const posts = await nativePosts.getPosts({
    filter: "latestEpisode",
    page: 1,
    providerValue: "animepaheHSub",
    signal: new AbortController().signal,
    providerContext: native.context,
  });
  assert.equal(posts[0].title, "ONE PIECE");
  assert.match(posts[0].tag, /1080p/);
  assert.equal(seen[0].headers.Origin, "https://justanime.to");
  assert.equal(native.webViewCalls(), 0);
}

async function testNativeEpisodesCombinePages() {
  const native = makeNativeContext(async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return {
      data: {
        totalPages: 2,
        episodes:
          page === 1
            ? [{ number: 1, title: "Beginning" }]
            : [{ number: 2, title: "Next" }],
      },
    };
  });
  const episodes = await nativeEpisodes.getEpisodes({
    url: "https://justanime.to/anime/21",
    providerContext: native.context,
  });
  assert.deepEqual(
    episodes.map((episode) => episode.title),
    ["Episode 2 — Next", "Episode 1 — Beginning"],
  );
  assert.match(episodes[0].link, /\/watch\/21\/episode\/2$/);
}

async function testNativePlaybackAndDownloadPrefer1080() {
  const native = makeNativeContext(async (url) => {
    if (url.includes("/download/animegg")) {
      return {
        data: {
          downloads: [
            {
              quality: "720p",
              resolution: 720,
              filesize: "170MB",
              download: "https://proxy.example/720.mp4",
            },
            {
              quality: "1080p",
              resolution: 1080,
              filesize: "290MB",
              download: "https://proxy.example/1080.mp4",
            },
          ],
        },
      };
    }
    return {
      data: {
        sub: {
          sources: [
            {
              url: "https://video.example/720.mp4",
              quality: "720p",
              isM3U8: false,
              headers: { Referer: "https://www.animegg.org/" },
            },
            {
              url: "https://video.example/1080.mp4",
              quality: "1080p",
              isM3U8: false,
              headers: { Referer: "https://www.animegg.org/" },
            },
          ],
        },
      },
    };
  });
  const args = {
    link: "https://justanime.to/watch/21/episode/1177",
    type: "series",
    signal: new AbortController().signal,
    providerContext: native.context,
  };
  const playback = await nativeStream.getStream(args);
  assert.deepEqual(playback.map((stream) => stream.quality), ["1080", "720"]);
  assert.equal(playback[0].headers.Referer, "https://www.animegg.org/");
  const downloads = await nativeStream.getStream({ ...args, isDownload: true });
  assert.deepEqual(downloads.map((stream) => stream.quality), ["1080", "720"]);
  assert.equal(downloads[0].link, "https://proxy.example/1080.mp4");
  assert.match(downloads[0].server, /290MB/);
  assert.equal(native.webViewCalls(), 0);
}

async function testMissingAnimeGgEpisodeUsesHardSub1080Fallback() {
  const native = makeNativeContext(async (url) => {
    if (url.endsWith("/api/anime/135865")) {
      return {
        data: {
          data: {
            title: {
              english: "One Piece",
              romaji: "One Piece",
            },
          },
        },
      };
    }
    const fixture = hardSubFixture(url);
    if (fixture !== undefined) return { data: fixture };
    const error = new Error("Request failed with status code 404");
    error.response = { status: 404 };
    throw error;
  });
  const streams = await nativeStream.getStream({
    link: "https://justanime.to/watch/135865/episode/2",
    type: "series",
    signal: new AbortController().signal,
    providerContext: native.context,
    isDownload: true,
  });
  assert.equal(streams.length, 3);
  assert.equal(streams[0].type, "m3u8");
  assert.equal(streams[0].quality, "1080");
  assert.equal(streams[0].subtitles, undefined);
  assert.equal(streams[0].tag, "H-Sub");
  assert.match(streams[0].server, /1080p • 800\.5 MB/);
  assert.equal(native.webViewCalls(), 0);
}

async function main() {
  await testAnikaiUsesFast1080HardSubsWithoutBlogger();
  await testNativeCatalogUsesAllowedOriginWithoutWebView();
  await testNativeEpisodesCombinePages();
  await testNativePlaybackAndDownloadPrefer1080();
  await testMissingAnimeGgEpisodeUsesHardSub1080Fallback();
  console.log("1080p Hard-Sub, size, download and no-WebView checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
