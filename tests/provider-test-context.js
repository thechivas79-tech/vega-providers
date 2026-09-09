const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const urlsEndpoint =
  "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/refs/heads/main/urls.json";
const nativeFetch = global.fetch;

global.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url === urlsEndpoint) {
    const providerUrls = fs.readFileSync(
      path.join(rootDir, "urls.json"),
      "utf-8",
    );
    return new Response(providerUrls, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return nativeFetch(input, init);
};

// The sandbox exposes atob/btoa; Node before 16 and some runners do not.
if (typeof global.atob !== "function") {
  global.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

// Providers read their settings and cached sessions through kvStore, so the CLI
// needs a working (in-memory) implementation rather than an absent one.
const kvValues = new Map();
const kvStore = {
  get: async (key) => kvValues.get(key),
  set: async (key, value) => void kvValues.set(key, value),
  delete: async (key) => kvValues.delete(key),
  keys: async () => [...kvValues.keys()],
  clear: async () => kvValues.clear(),
};

const providerContext = {
  axios,
  cheerio,
  commonHeaders: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
  kvStore,
  // Solving a WAF challenge needs the app's real WebView; the CLI can only say so.
  openWebView: async (url) => {
    throw new Error(
      `openWebView is only available inside Vega (requested ${url})`,
    );
  },
  Aes: {},
};

module.exports = { providerContext, kvStore };
