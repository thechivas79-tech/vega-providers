const assert = require("node:assert/strict");

const blogger = require("../dist/anikaiHSub/stream.js");
const animePahe = require("../dist/animepaheHSub/stream.js");
const animePahePosts = require("../dist/animepaheHSub/posts.js");

const bloggerPayload = JSON.stringify([
  [
    "wrb.fr",
    "WcwnYd",
    JSON.stringify([null, null, [["https://video.example/file.mp4", [22]]]]),
  ],
]);
assert.deepEqual(blogger.parseBloggerBatchResponse(bloggerPayload), [
  ["https://video.example/file.mp4", [22]],
]);

const packedKwik =
  "eval(function(p,a,c,k,e,d){return p;}('0 1=\\'2://3/4.5\\';',6,6,'const|source|https|cdn.example|video|m3u8'.split('|'),0,{}))";
assert.equal(
  animePahe.extractKwikSource(packedKwik),
  "https://cdn.example/video.m3u8",
);

async function testAnimePaheCloudflareRetry() {
  const values = new Map();
  let calls = 0;
  let openedUrl = "";
  const providerContext = {
    commonHeaders: { "User-Agent": "Vega test" },
    cheerio: require("cheerio"),
    axios: {
      get: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("Request failed with status code 403");
          error.response = { status: 403 };
          throw error;
        }
        return {
          data: {
            current_page: 1,
            last_page: 1,
            data: [
              {
                anime_id: 1,
                anime_session: "session",
                anime_title: "Test Anime",
                snapshot: "https://example.com/poster.jpg",
              },
            ],
          },
        };
      },
    },
    openWebView: async (url) => {
      openedUrl = url;
      return {
        data: "",
        cookies: "cf_clearance=test",
        cookieMap: { cf_clearance: "test" },
        userAgent: "Vega test",
        url,
      };
    },
    kvStore: {
      get: async (key) => values.get(key),
      set: async (key, value) => values.set(key, value),
      delete: async (key) => values.delete(key),
      keys: async () => [...values.keys()],
      clear: async () => values.clear(),
    },
  };
  const posts = await animePahePosts.getPosts({
    filter: "airing",
    page: 1,
    providerValue: "animepaheHSub",
    signal: new AbortController().signal,
    providerContext,
  });
  assert.equal(openedUrl, "https://animepahe.pw/");
  assert.equal(calls, 2);
  assert.equal(posts[0].title, "Test Anime");
}

testAnimePaheCloudflareRetry()
  .then(() => console.log("Provider parser and Cloudflare retry checks passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
