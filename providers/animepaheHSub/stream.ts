import { ProviderContext, Stream } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  getAnimePaheHtml,
  getBaseUrl,
  getWithClearance,
} from "./client";

const PACKER_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function encodePackerNumber(value: number, radix: number): string {
  if (value === 0) return "0";
  let current = value;
  let output = "";
  while (current > 0) {
    output = PACKER_ALPHABET[current % radix] + output;
    current = Math.floor(current / radix);
  }
  return output;
}

function unescapeJavascriptString(value: string): string {
  return value.replace(
    /\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|n|r|t|b|f|v|0|\\|'|")/g,
    (_, token: string) => {
      if (token.startsWith("u")) {
        return String.fromCharCode(parseInt(token.slice(1), 16));
      }
      if (token.startsWith("x")) {
        return String.fromCharCode(parseInt(token.slice(1), 16));
      }
      const escaped: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
        "\\": "\\",
        "'": "'",
        '"': '"',
      };
      return escaped[token] ?? token;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function unpackDeanEdwards(source: string): string {
  const patterns = [
    /eval\(function\(p,a,c,k,e,(?:d|r)\)[\s\S]*?\}\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\.split\(\s*'\|'\s*\)/,
    /eval\(function\(p,a,c,k,e,(?:d|r)\)[\s\S]*?\}\(\s*"((?:\\.|[^"\\])*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"((?:\\.|[^"\\])*)"\.split\(\s*"\|"\s*\)/,
  ];
  const match = patterns.map((pattern) => pattern.exec(source)).find(Boolean);
  if (!match) throw new Error("Kwik's packed script was missing");
  const payload = unescapeJavascriptString(match[1]);
  const radix = Number(match[2]);
  const count = Number(match[3]);
  const dictionary = unescapeJavascriptString(match[4]).split("|");
  if (radix < 2 || radix > PACKER_ALPHABET.length) {
    throw new Error(`Kwik used unsupported packer radix ${radix}`);
  }

  let unpacked = payload;
  for (let index = count - 1; index >= 0; index -= 1) {
    const replacement = dictionary[index];
    if (!replacement) continue;
    const token = encodePackerNumber(index, radix);
    unpacked = unpacked.replace(
      new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"),
      replacement,
    );
  }
  return unpacked;
}

export function extractKwikSource(html: string): string {
  const unpacked = unpackDeanEdwards(html);
  const explicit = unpacked.match(
    /const\s+source\s*=\s*\\?['"](https?:\\?\/\\?\/[^'"\s]+?\.m3u8[^'"]*)/i,
  )?.[1];
  const fallback = unpacked.match(
    /https?:\\?\/\\?\/[^'"\\\s]+\.m3u8[^'"\\\s]*/i,
  )?.[0];
  const stream = (explicit || fallback || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&");
  if (!stream) throw new Error("Kwik HLS source was missing after unpacking");
  return stream;
}

async function resolveKwik(
  url: string,
  baseUrl: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<{ url: string; referer: string; userAgent: string }> {
  let response = await getWithClearance(providerContext, url, {
    namespace: "kwik",
    referer: `${baseUrl}/`,
    title: "Kwik security check",
    description: "Complete the video host security check, then return to Vega.",
    signal,
  });
  let html = String(response.data || "");
  if (!/eval\(function\(p,a,c,k,e,/i.test(html)) {
    response = await getWithClearance(providerContext, response.finalUrl || url, {
      namespace: "kwik",
      referer: `${baseUrl}/`,
      title: "Kwik video check",
      description: "Open the player once so Vega can resolve its H-Sub stream.",
      signal,
      forceWebViewOnHtml: true,
    });
    html = String(response.data || "");
  }
  return {
    url: extractKwikSource(html),
    referer: response.finalUrl || url,
    userAgent: response.userAgent,
  };
}

function qualityOf(label: string): string {
  return label.match(/(360|480|720|1080|2160)\s*p?/i)?.[1] || "";
}

export async function getStream({
  link,
  signal,
  providerContext,
}: {
  link: string;
  type: string;
  signal?: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}): Promise<Stream[]> {
  try {
    const baseUrl = await getBaseUrl(providerContext);
    const playUrl = new URL(link, `${baseUrl}/`);
    playUrl.searchParams.delete("anime_id");
    const html = await getAnimePaheHtml(
      providerContext,
      playUrl.href,
      signal,
    );
    const $ = providerContext.cheerio.load(html);
    const preferred =
      (await providerContext.kvStore.get<string>("preferredQuality")) ||
      "1080";
    const allowed =
      (await providerContext.kvStore.get<string[]>("allowedResolutions")) ||
      ["1080", "720", "360"];
    const candidates = $("div#resolutionMenu > button[data-src]")
      .map((_: number, node: any) => ({
        url: $(node).attr("data-src") || "",
        label: $(node).text().replace(/\s+/g, " ").trim(),
      }))
      .get()
      .filter((item: { url: string; label: string }) => {
        const quality = qualityOf(item.label);
        return item.url && (!quality || allowed.includes(quality));
      });

    const streams: Stream[] = [];
    for (const candidate of candidates) {
      try {
        const resolved = await resolveKwik(
          candidate.url,
          baseUrl,
          providerContext,
          signal,
        );
        const quality = qualityOf(candidate.label);
        streams.push({
          server: candidate.label || `Kwik ${quality || "HLS"}`,
          link: resolved.url,
          type: "m3u8",
          quality: quality || undefined,
          tag: "H-Sub",
          tags: ["H-Sub", "English Subbed"],
          headers: {
            Origin: "https://kwik.cx",
            Referer: resolved.referer,
            "User-Agent": resolved.userAgent,
          },
        });
      } catch (error) {
        console.log("AnimePahe Kwik source failed", error);
      }
    }
    const unique = streams.filter(
      (stream, index, all) =>
        all.findIndex((candidate) => candidate.link === stream.link) === index,
    );
    unique.sort((left, right) => {
      const leftPreferred = left.quality === preferred ? 1 : 0;
      const rightPreferred = right.quality === preferred ? 1 : 0;
      return (
        rightPreferred - leftPreferred ||
        Number(right.quality || 0) - Number(left.quality || 0)
      );
    });
    if (!unique.length) throw new Error("No playable AnimePahe H-Sub streams were found");
    return unique;
  } catch (error) {
    throwProviderError("AnimePahe H-Sub", "stream", error);
  }
}
