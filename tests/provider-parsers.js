const assert = require("node:assert/strict");

const blogger = require("../dist/anikaiHSub/stream.js");
const animePahe = require("../dist/animepaheHSub/stream.js");

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

console.log("Provider parser checks passed");
