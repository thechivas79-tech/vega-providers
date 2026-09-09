import { ProviderContext, Stream, TextTracks } from "../types";
import { throwProviderError } from "../providerErrors";
import { extractKwikSource, kwikQuality } from "../extractors/kwik";
import { absoluteUrl, getBaseUrl, getHtml } from "./client";

type BloggerFormat = [string, number[]?];

// Blogger only ever transcodes 360p (itag 18) and 720p (itag 22). The taller
// itags are kept for the rare upload that already carries them.
const ITAG_QUALITY: Record<number, string> = {
  17: "144",
  18: "360",
  59: "480",
  22: "720",
  37: "1080",
  38: "2160",
};

const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Google signs every googlevideo URL with an `eaua` parameter derived from the
// User-Agent that asked for it, and `eaua` is covered by the URL signature.
// Playing the URL back with a different User-Agent returns HTTP 403, so the
// exact same value has to be used to resolve the URL and to fetch the video.
function streamUserAgent(providerContext: ProviderContext): string {
  const headers = providerContext.commonHeaders || {};
  return headers["User-Agent"] || headers["user-agent"] || FALLBACK_USER_AGENT;
}

function decodeBase64(value: string): string {
  try {
    return atob(value);
  } catch {
    return "";
  }
}

function getWizData(html: string): Record<string, unknown> {
  const marker = "window.WIZ_global_data = ";
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("Blogger configuration was missing");
  const valueStart = start + marker.length;
  const valueEnd = html.indexOf(";</script>", valueStart);
  if (valueEnd < 0) throw new Error("Blogger configuration was incomplete");
  return JSON.parse(html.slice(valueStart, valueEnd));
}

export function parseBloggerBatchResponse(data: string): BloggerFormat[] {
  for (const line of data.split(/\r?\n/)) {
    const value = line.trim();
    if (!value.startsWith("[[")) continue;
    try {
      const rows = JSON.parse(value);
      for (const row of rows) {
        if (row?.[0] !== "wrb.fr" || row?.[1] !== "WcwnYd") continue;
        const payload = JSON.parse(row[2]);
        if (Array.isArray(payload?.[2])) return payload[2] as BloggerFormat[];
      }
    } catch {
      // Batchexecute responses contain length lines between JSON chunks.
    }
  }
  return [];
}

function itagOf(url: string, itags?: number[]): number {
  const fromPayload = Number(itags?.[0]);
  if (Number.isFinite(fromPayload) && fromPayload > 0) return fromPayload;
  try {
    return Number(new URL(url).searchParams.get("itag")) || 0;
  } catch {
    return 0;
  }
}

async function resolveBlogger(
  playerUrl: string,
  pageUrl: string,
  userAgent: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<Stream[]> {
  const { axios, commonHeaders } = providerContext;
  const token = new URL(playerUrl).searchParams.get("token");
  if (!token) throw new Error("Blogger token was missing");

  const player = await axios.get(playerUrl, {
    signal,
    headers: {
      ...commonHeaders,
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml",
      Referer: pageUrl,
    },
  });
  const wiz = getWizData(String(player.data || ""));
  const sid = String(wiz.FdrFJe || "");
  const buildLabel = String(wiz.cfb2h || "");
  if (!sid || !buildLabel) throw new Error("Blogger RPC metadata was missing");

  const endpoint = new URL(
    "/_/BloggerVideoPlayerUi/data/batchexecute",
    playerUrl,
  );
  endpoint.searchParams.set("rpcids", "WcwnYd");
  endpoint.searchParams.set("source-path", "/video.g");
  endpoint.searchParams.set("f.sid", sid);
  endpoint.searchParams.set("bl", buildLabel);
  endpoint.searchParams.set("hl", "en-US");
  endpoint.searchParams.set("_reqid", String((Date.now() % 900000) + 100000));
  endpoint.searchParams.set("rt", "c");

  const request = JSON.stringify([
    [["WcwnYd", JSON.stringify([token, null, 0]), null, "generic"]],
  ]);
  const response = await axios.post(
    endpoint.href,
    `f.req=${encodeURIComponent(request)}&`,
    {
      signal,
      headers: {
        ...commonHeaders,
        "User-Agent": userAgent,
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
        Origin: new URL(playerUrl).origin,
        Referer: playerUrl,
      },
    },
  );

  const formats = parseBloggerBatchResponse(String(response.data || ""));
  return formats
    .filter((format) => typeof format?.[0] === "string")
    .map(([url, itags]) => {
      const itag = itagOf(url, itags);
      const quality = ITAG_QUALITY[itag] || "";
      return {
        server: `Blogger ${quality || itag || "MP4"}${quality ? "p" : ""}`,
        link: url,
        type: "mp4",
        quality: quality || undefined,
        tag: "H-Sub",
        tags: ["H-Sub", "English Subbed"],
        headers: {
          Referer: "https://www.blogger.com/",
          "User-Agent": userAgent,
        },
      } satisfies Stream;
    });
}

// Part of Anikai's back catalogue is hosted on Kwik, the same player
// AnimePahe uses. Kwik only answers for a Referer on its own allowlist, and its
// WAF rejects HTTP/1.1 clients outright, so a plain request can come back
// blocked even with perfect headers - hence the WebView fallback.
async function fetchKwikPage(
  embedUrl: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  let blocked: unknown;
  try {
    const html = await getHtml(providerContext, embedUrl, signal);
    if (/eval\(function\(p,a,c,k,e,/i.test(html)) return html;
    blocked = new Error("Kwik returned a page without its player script");
  } catch (error) {
    blocked = error;
  }
  if (typeof providerContext.openWebView !== "function") throw blocked;

  const solved = await providerContext.openWebView(embedUrl, {
    title: "Kwik player check",
    description: "Open the player once so Vega can read its H-Sub stream.",
    force: true,
    timeoutMs: 120000,
  });
  const html = String(solved.data || "");
  if (!/eval\(function\(p,a,c,k,e,/i.test(html)) throw blocked;
  return html;
}

async function resolveKwik(
  embedUrl: string,
  userAgent: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<Stream[]> {
  const origin = new URL(embedUrl).origin;
  const html = await fetchKwikPage(embedUrl, providerContext, signal);
  const source = extractKwikSource(html);
  const quality = kwikQuality(html);
  return [
    {
      server: `Kwik ${quality ? `${quality}p` : "HLS"}`,
      link: source,
      type: "m3u8",
      quality: quality || undefined,
      tag: "H-Sub",
      tags: ["H-Sub", "English Subbed"],
      headers: {
        Origin: origin,
        Referer: embedUrl,
        "User-Agent": userAgent,
      },
    },
  ];
}

interface Embed {
  url: string;
  host: string;
}

function collectEmbeds(
  html: string,
  pageUrl: string,
  providerContext: ProviderContext,
): Embed[] {
  const $ = providerContext.cheerio.load(html);
  const origin = new URL(pageUrl).origin;
  const links: string[] = [];

  $("#embed_holder iframe[src], .player-embed iframe[src], #pembed iframe[src]")
    .each((_, node) => {
      const value = $(node).attr("src");
      if (value) links.push(absoluteUrl(value, origin));
    });

  $("select.mirror option[value]").each((_, node) => {
    const decoded = decodeBase64($(node).attr("value") || "");
    if (!decoded) return;
    const mirror = providerContext.cheerio.load(decoded);
    mirror("iframe[src], source[src], video[src]").each((__, media) => {
      const value = mirror(media).attr("src");
      if (value) links.push(absoluteUrl(value, origin));
    });
  });

  $("video[src], video source[src]").each((_, node) => {
    const value = $(node).attr("src");
    if (value) links.push(absoluteUrl(value, origin));
  });

  const embeds: Embed[] = [];
  const seen = new Set<string>();
  for (const url of links) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    try {
      embeds.push({ url, host: new URL(url).host });
    } catch {
      // Ignore embeds that are not resolvable URLs.
    }
  }
  return embeds;
}

// Much of Anikai's back catalogue sits on megaplay, whose getSources endpoint
// returns the video as an encrypted `enc` blob. The subtitle track next to it is
// still plain, so it is worth attaching to whatever else the page offers.
async function megaplaySubtitles(
  embedUrl: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<TextTracks> {
  const html = await getHtml(providerContext, embedUrl, signal);
  const id = html.match(/data-id="(\d+)"/)?.[1];
  if (!id) return [];
  const sources = new URL("/stream/getSources", embedUrl);
  sources.searchParams.set("id", id);
  const response = await providerContext.axios.get(sources.href, {
    signal,
    headers: {
      ...providerContext.commonHeaders,
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Referer: embedUrl,
    },
  });
  const payload =
    typeof response.data === "string"
      ? JSON.parse(response.data)
      : response.data;
  return (payload?.tracks || [])
    .filter((track: any) => track?.file && track?.kind === "captions")
    .map((track: any) => ({
      title: String(track.label || "Subtitles"),
      language: String(track.label || "English").slice(0, 2).toLowerCase(),
      type: "text/vtt" as const,
      uri: String(track.file),
    }));
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
    const pageUrl = absoluteUrl(link, baseUrl);
    const html = await getHtml(providerContext, pageUrl, signal);
    const userAgent = streamUserAgent(providerContext);
    const embeds = collectEmbeds(html, pageUrl, providerContext);
    const streams: Stream[] = [];
    let subtitles: TextTracks = [];
    const unsupported = new Set<string>();

    for (const embed of embeds) {
      if (/blogger\.com\/video\.g/i.test(embed.url)) {
        try {
          streams.push(
            ...(await resolveBlogger(
              embed.url,
              pageUrl,
              userAgent,
              providerContext,
              signal,
            )),
          );
        } catch (error) {
          console.log("Anikai Blogger source failed", error);
        }
      } else if (/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(embed.url)) {
        streams.push({
          server: "Anikai Direct",
          link: embed.url,
          type: /\.m3u8(?:[?#]|$)/i.test(embed.url) ? "m3u8" : "mp4",
          tag: "H-Sub",
          tags: ["H-Sub", "English Subbed"],
          headers: { Referer: pageUrl, "User-Agent": userAgent },
        });
      } else if (/(^|\.)kwik\./i.test(embed.host)) {
        try {
          streams.push(
            ...(await resolveKwik(
              embed.url,
              userAgent,
              providerContext,
              signal,
            )),
          );
        } catch (error) {
          console.log("Anikai Kwik source failed", error);
        }
      } else if (/megaplay\./i.test(embed.host)) {
        unsupported.add(embed.host);
        try {
          subtitles = await megaplaySubtitles(
            embed.url,
            providerContext,
            signal,
          );
        } catch (error) {
          console.log("Anikai megaplay subtitles failed", error);
        }
      } else {
        unsupported.add(embed.host);
      }
    }

    const deduped = streams.filter(
      (stream, index, all) =>
        all.findIndex((candidate) => candidate.link === stream.link) === index,
    );
    deduped.sort(
      (left, right) => Number(right.quality || 0) - Number(left.quality || 0),
    );
    if (!deduped.length) {
      throw new Error(
        unsupported.size
          ? `This episode is only hosted on ${[...unsupported].join(", ")}, which this provider cannot resolve yet`
          : "No playable H-Sub streams were found",
      );
    }
    if (subtitles.length) {
      for (const stream of deduped) stream.subtitles = subtitles;
    }
    return deduped;
  } catch (error) {
    throwProviderError("Anikai H-Sub", "stream", error);
  }
}
