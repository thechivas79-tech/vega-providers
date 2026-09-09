import { ProviderContext, Stream } from "../types";
import { throwProviderError } from "../providerErrors";
import { absoluteUrl, getBaseUrl, getHtml } from "./client";

type BloggerFormat = [string, number[]?];

const ITAG_QUALITY: Record<number, string> = {
  17: "144",
  18: "360",
  22: "720",
  37: "1080",
  59: "480",
};

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

async function resolveBlogger(
  playerUrl: string,
  pageUrl: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<Stream[]> {
  const { axios, commonHeaders } = providerContext;
  const token = new URL(playerUrl).searchParams.get("token");
  if (!token) throw new Error("Blogger token was missing");

  const player = await axios.get(playerUrl, {
    signal,
    headers: { ...commonHeaders, Referer: pageUrl },
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
        Accept: "*/*",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Origin: new URL(playerUrl).origin,
        Referer: playerUrl,
      },
    },
  );

  const formats = parseBloggerBatchResponse(String(response.data || ""));
  return formats
    .filter((format) => typeof format?.[0] === "string")
    .map(([url, itags]) => {
      const itag = Number(itags?.[0] || new URL(url).searchParams.get("itag"));
      return {
        server: `Blogger ${ITAG_QUALITY[itag] || itag || "MP4"}p`,
        link: url,
        type: "mp4",
        quality: ITAG_QUALITY[itag] || undefined,
        tag: "H-Sub",
        tags: ["H-Sub", "English Subbed"],
        headers: { Referer: "https://www.blogger.com/" },
      } satisfies Stream;
    });
}

function collectEmbeds(
  html: string,
  pageUrl: string,
  providerContext: ProviderContext,
): string[] {
  const $ = providerContext.cheerio.load(html);
  const links: string[] = [];

  $("#embed_holder iframe[src], .player-embed iframe[src]").each((_, node) => {
    const value = $(node).attr("src");
    if (value) links.push(absoluteUrl(value, pageUrl));
  });

  $("select.mirror option[value]").each((_, node) => {
    const decoded = decodeBase64($(node).attr("value") || "");
    if (!decoded) return;
    const mirror = providerContext.cheerio.load(decoded);
    mirror("iframe[src], source[src], video[src]").each((__, media) => {
      const value = mirror(media).attr("src");
      if (value) links.push(absoluteUrl(value, pageUrl));
    });
  });

  $("video[src], video source[src]").each((_, node) => {
    const value = $(node).attr("src");
    if (value) links.push(absoluteUrl(value, pageUrl));
  });

  return [...new Set(links)];
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
    const streams: Stream[] = [];

    for (const embed of collectEmbeds(html, pageUrl, providerContext)) {
      if (/blogger\.com\/video\.g/i.test(embed)) {
        try {
          streams.push(
            ...(await resolveBlogger(embed, pageUrl, providerContext, signal)),
          );
        } catch (error) {
          console.log("Anikai Blogger source failed", error);
        }
      } else if (/\.(?:m3u8|mp4)(?:[?#]|$)/i.test(embed)) {
        streams.push({
          server: "Anikai Direct",
          link: embed,
          type: /\.m3u8(?:[?#]|$)/i.test(embed) ? "m3u8" : "mp4",
          tag: "H-Sub",
          tags: ["H-Sub", "English Subbed"],
          headers: { Referer: pageUrl },
        });
      }
    }

    const deduped = streams.filter(
      (stream, index, all) =>
        all.findIndex((candidate) => candidate.link === stream.link) === index,
    );
    deduped.sort(
      (left, right) => Number(right.quality || 0) - Number(left.quality || 0),
    );
    if (!deduped.length) throw new Error("No playable H-Sub streams were found");
    return deduped;
  } catch (error) {
    throwProviderError("Anikai H-Sub", "stream", error);
  }
}
