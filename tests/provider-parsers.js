const assert = require("node:assert/strict");
const cheerio = require("cheerio");

const anikaiStream = require("../dist/anikaiHSub/stream.js");
const animePahe = require("../dist/animepaheHSub/stream.js");
const animePahePosts = require("../dist/animepaheHSub/posts.js");

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

function httpError(status) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status };
  return error;
}

// The live Cloudflare interstitial AnimePahe serves today.
const CLOUDFLARE_INTERSTITIAL = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="content-security-policy" content="script-src 'nonce-x' https://challenges.cloudflare.com">
</head><body><h2>Performing security verification</h2>
<div id="challenge-form"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
</body></html>`;

const AIRING_PAGE = {
  current_page: 1,
  last_page: 3,
  data: [
    {
      anime_id: 1,
      anime_session: "session",
      anime_title: "Test Anime",
      snapshot: "https://example.com/poster.jpg",
      fansub: "SubsPlease",
    },
  ],
};

function parsersPass() {
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

  const packedKwik =
    "eval(function(p,a,c,k,e,d){return p;}('0 1=\\'2://3/4.5\\';',6,6,'const|source|https|cdn.example|video|m3u8'.split('|'),0,{}))";
  assert.equal(
    animePahe.extractKwikSource(packedKwik),
    "https://cdn.example/video.m3u8",
  );

  // Kwik ships two packed blocks: a cookie helper first, the player source
  // second. Only unpacking the first one is why live Kwik pages stopped
  // resolving.
  const packedCookieHelper =
    "eval(function(p,a,c,k,e,d){return p;}('0 1=2;',3,3,'var|cookie|helper'.split('|'),0,{}))";
  assert.equal(
    animePahe.extractKwikSource(`${packedCookieHelper}\n${packedKwik}`),
    "https://cdn.example/video.m3u8",
    "the packed block holding the source must be found wherever it sits",
  );
  assert.throws(
    () => animePahe.extractKwikSource(packedCookieHelper),
    /missing after unpacking/,
  );
}

// Google signs googlevideo URLs against the User-Agent that requested them, so
// a mismatch between resolving and playback is exactly the HTTP 403 we had.
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
        if (url.includes("blogger.com/video.g")) return { data: playerHtml };
        return { data: episodeHtml };
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

  assert.deepEqual(
    streams.map((stream) => stream.quality),
    ["720", "360"],
    "highest quality must be offered first",
  );
  const resolverAgents = new Set(seen.map(([, agent]) => agent));
  assert.deepEqual([...resolverAgents], ["Vega/1.0 (Android)"]);
  for (const stream of streams) {
    assert.equal(
      stream.headers["User-Agent"],
      "Vega/1.0 (Android)",
      "playback User-Agent must be the one the URL was signed for",
    );
  }
}

async function testAnikaiReportsEncryptedHost() {
  const providerContext = {
    commonHeaders: { "User-Agent": "Vega/1.0" },
    cheerio,
    kvStore: makeKvStore(),
    axios: {
      get: async (url) => {
        if (url.includes("getSources")) return { data: { tracks: [] } };
        if (url.includes("megaplay")) {
          return { data: '<div id="player" data-id="1"></div>' };
        }
        return {
          data:
            '<div id="embed_holder"><iframe src="https://megaplay.buzz/stream/s-2/1/sub"></iframe></div>',
        };
      },
    },
  };
  await assert.rejects(
    anikaiStream.getStream({
      link: "https://anikai.tv/show-episode-1-english-subbed/",
      type: "series",
      providerContext,
    }),
    /megaplay\.buzz/,
  );
}

// The WebView has to be pointed at the request we actually want, so its own
// rendered response can be used when the cookie cannot be replayed.
async function testAnimePaheOpensTargetUrl() {
  let calls = 0;
  const opened = [];
  const providerContext = {
    commonHeaders: { "User-Agent": "Vega test" },
    cheerio,
    kvStore: makeKvStore(),
    axios: {
      get: async () => {
        calls += 1;
        if (calls === 1) throw httpError(403);
        return { data: AIRING_PAGE };
      },
    },
    openWebView: async (url) => {
      opened.push(url);
      return {
        data: "",
        cookies: "cf_clearance=test",
        cookieMap: { cf_clearance: "test" },
        userAgent: "WebView UA",
        url,
      };
    },
  };

  const posts = await animePahePosts.getPosts({
    filter: "airing",
    page: 1,
    providerValue: "animepaheHSub",
    signal: new AbortController().signal,
    providerContext,
  });
  assert.deepEqual(opened, ["https://animepahe.pw/api?m=airing&page=1"]);
  assert.equal(calls, 2);
  assert.equal(posts[0].title, "Test Anime");
  assert.equal(posts[0].tag, "SubsPlease • H-Sub");
}

// Cloudflare hands back a challenge page with HTTP 200 as often as with 403,
// and the clearance cookie is regularly not replayable outside the WebView.
async function testAnimePaheUsesWebViewBody() {
  let calls = 0;
  const providerContext = {
    commonHeaders: { "User-Agent": "Vega test" },
    cheerio,
    kvStore: makeKvStore(),
    axios: {
      get: async () => {
        calls += 1;
        return { data: CLOUDFLARE_INTERSTITIAL };
      },
    },
    openWebView: async (url) => ({
      // What a real WebView shows for a JSON response.
      data: `<html><head></head><body><pre style="word-wrap: break-word;">${JSON.stringify(
        AIRING_PAGE,
      ).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></body></html>`,
      cookies: "__cf_bm=only",
      cookieMap: { __cf_bm: "only" },
      userAgent: "WebView UA",
      url,
    }),
  };

  const posts = await animePahePosts.getPosts({
    filter: "airing",
    page: 1,
    providerValue: "animepaheHSub",
    signal: new AbortController().signal,
    providerContext,
  });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, "Test Anime");
  assert.equal(calls, 1, "the WebView body must be used without extra retries");
}

// Episode pagination and multi-resolution streams fan out; one dialog only.
async function testAnimePaheSharesOneDialog() {
  let opens = 0;
  const providerContext = {
    commonHeaders: { "User-Agent": "Vega test" },
    cheerio,
    kvStore: makeKvStore(),
    axios: {
      get: async (url) => {
        const cleared = url.includes("page=1") ? opens > 0 : opens > 0;
        if (!cleared) throw httpError(403);
        return { data: AIRING_PAGE };
      },
    },
    openWebView: async (url) => {
      opens += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        data: "",
        cookies: "cf_clearance=test",
        cookieMap: { cf_clearance: "test" },
        userAgent: "WebView UA",
        url,
      };
    },
  };

  const request = (page) =>
    animePahePosts.getPosts({
      filter: "airing",
      page,
      providerValue: "animepaheHSub",
      signal: new AbortController().signal,
      providerContext,
    });
  const results = await Promise.all([request(1), request(2), request(3)]);
  assert.equal(opens, 1, "parallel scrapes must share a single WebView");
  for (const posts of results) assert.equal(posts[0].title, "Test Anime");
}

async function testAnimePaheExplainsFailedVerification() {
  const providerContext = {
    commonHeaders: { "User-Agent": "Vega test" },
    cheerio,
    kvStore: makeKvStore(),
    axios: { get: async () => { throw httpError(403); } },
    openWebView: async (url) => ({
      data: CLOUDFLARE_INTERSTITIAL,
      cookies: "",
      cookieMap: {},
      userAgent: "WebView UA",
      url,
    }),
  };
  await assert.rejects(
    animePahePosts.getPosts({
      filter: "airing",
      page: 1,
      providerValue: "animepaheHSub",
      signal: new AbortController().signal,
      providerContext,
    }),
    /Verify you are human/,
  );
}

async function main() {
  parsersPass();
  await testAnikaiStreamUserAgentMatchesResolver();
  await testAnikaiReportsEncryptedHost();
  await testAnimePaheOpensTargetUrl();
  await testAnimePaheUsesWebViewBody();
  await testAnimePaheSharesOneDialog();
  await testAnimePaheExplainsFailedVerification();
  console.log("Provider parser, stream header and Cloudflare checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
