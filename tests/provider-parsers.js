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

function bloggerParserPasses() {
  const bloggerPayload = JSON.stringify([
    [
      "wrb.fr",
      "WcwnYd",
      JSON.stringify([null, null, [["https://video.example/file.mp4", [22]]]]),
    ],
  ]);
  assert.deepEqual(anikaiStream.parseBloggerBatchResponse(bloggerPayload), [
    ["https://video.example/file.mp4", [22]],
  ]);
}

async function testAnikaiStreamUserAgentMatchesResolver() {
  const seen = [];
  const episodeHtml = `<div id="embed_holder"><iframe src="https://www.blogger.com/video.g?token=TOKEN&origin=op.blogspot.com"></iframe></div>`;
  const playerHtml = `<script>window.WIZ_global_data = {"FdrFJe":"-123","cfb2h":"boq_test"};</script>`;
  const batch = `)]}'\n\n[["wrb.fr","WcwnYd",${JSON.stringify(
    JSON.stringify([
      null,
      null,
      [
        ["https://rr1.googlevideo.com/videoplayback?itag=22&eaua=hash", [22]],
        ["https://rr1.googlevideo.com/videoplayback?itag=18&eaua=hash", [18]],
      ],
    ]),
  )}]]`;
  const providerContext = {
    commonHeaders: { "User-Agent": "Vega/1.0 (Android)" },
    cheerio,
    kvStore: makeKvStore(),
    axios: {
      get: async (url, config) => {
        seen.push([url, config.headers["User-Agent"]]);
        return {
          data: url.includes("blogger.com/video.g") ? playerHtml : episodeHtml,
        };
      },
      post: async (url, _body, config) => {
        seen.push([url, config.headers["User-Agent"]]);
        return { data: batch };
      },
    },
  };
  const streams = await anikaiStream.getStream({
    link: "https://anikai.tv/show-episode-1-english-subbed/",
    type: "series",
    providerContext,
  });
  assert.deepEqual(streams.map((stream) => stream.quality), ["720", "360"]);
  assert.deepEqual(
    [...new Set(seen.map(([, agent]) => agent))],
    ["Vega/1.0 (Android)"],
  );
  for (const stream of streams) {
    assert.equal(stream.headers["User-Agent"], "Vega/1.0 (Android)");
  }
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

async function main() {
  bloggerParserPasses();
  await testAnikaiStreamUserAgentMatchesResolver();
  await testNativeCatalogUsesAllowedOriginWithoutWebView();
  await testNativeEpisodesCombinePages();
  await testNativePlaybackAndDownloadPrefer1080();
  console.log("Provider parser, 1080p, download and no-WebView checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
