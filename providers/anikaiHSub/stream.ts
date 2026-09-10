import { ProviderContext, Stream } from "../types";
import { throwProviderError } from "../providerErrors";
import { getAniNekoHardSubStreams } from "../extractors/anineko";
import { extractKwikSource, kwikQuality } from "../extractors/kwik";
import {
  absoluteUrl,
  cleanText,
  getBaseUrl,
  getHtml,
  seriesTitleFromEpisode,
} from "./client";

const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

// A small part of the back catalogue has a directly readable Kwik player. A
// blocked Kwik page is skipped so playback never opens a verification WebView.
async function fetchKwikPage(
  embedUrl: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string> {
  const html = await getHtml(providerContext, embedUrl, signal);
  if (!/eval\(function\(p,a,c,k,e,/i.test(html)) {
    throw new Error("Kwik returned a blocked player page");
  }
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

export async function getStream({
  link,
  signal,
  providerContext,
  isDownload,
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
    const $ = providerContext.cheerio.load(html);
    const heading = cleanText(
      $("h1.entry-title, .entry-title").first().text() ||
        $('meta[property="og:title"]').attr("content") ||
        $("title").text(),
    );
    const slugTitle = decodeURIComponent(new URL(pageUrl).pathname)
      .replace(/^\/+|\/+$/g, "")
      .replace(/-/g, " ");
    const episode =
      pageUrl.match(/episode[-/](\d+(?:\.\d+)?)/i)?.[1] ||
      heading.match(/episode\s+(\d+(?:\.\d+)?)/i)?.[1] ||
      slugTitle.match(/episode\s+(\d+(?:\.\d+)?)/i)?.[1] ||
      "1";
    const titles = [heading, slugTitle]
      .map(seriesTitleFromEpisode)
      .filter(Boolean);
    const preferred =
      (await providerContext.kvStore.get<string>("preferredQuality")) ||
      "1080";
    const allowed =
      (await providerContext.kvStore.get<string[]>("allowedResolutions")) ||
      ["1080", "720", "480", "360"];

    try {
      const fastStreams = await getAniNekoHardSubStreams({
        titles,
        episode,
        providerContext,
        signal,
        isDownload,
      });
      const filtered = fastStreams.filter(
        (stream) => !stream.quality || allowed.includes(stream.quality),
      );
      if (filtered.length) {
        return filtered.sort((left, right) => {
          const leftPreferred = left.quality === preferred ? 1 : 0;
          const rightPreferred = right.quality === preferred ? 1 : 0;
          return (
            rightPreferred - leftPreferred ||
            Number(right.quality || 0) - Number(left.quality || 0)
          );
        });
      }
    } catch (error) {
      console.log("Anikai fast 1080p H-Sub source failed", error);
    }

    const userAgent = streamUserAgent(providerContext);
    const embeds = collectEmbeds(html, pageUrl, providerContext);
    const streams: Stream[] = [];
    const unsupported = new Set<string>();

    for (const embed of embeds) {
      if (/blogger\.com\/video\.g/i.test(embed.url)) {
        // Blogger is deliberately excluded: its current 720p transcodes are
        // much slower than the dedicated 1080p H-Sub CDN above.
        unsupported.add("slow Blogger");
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
    return deduped;
  } catch (error) {
    throwProviderError("Anikai H-Sub", "stream", error);
  }
}
