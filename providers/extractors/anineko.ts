import { ProviderContext, Stream } from "../types";
import { unpackAll } from "./kwik";

const ANINEKO_BASE = "https://anineko.to";
const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

interface SearchResult {
  title: string;
  link: string;
  index: number;
}

interface EmbedResult {
  label: string;
  link: string;
}

interface ExtractedSource {
  link: string;
  duration?: number;
}

interface HlsVariant {
  link: string;
  quality: string;
  bandwidth: number;
}

type DownloadSizes = Record<string, string>;

export interface AniNekoHardSubRequest {
  titles: string[];
  episode: string | number;
  providerContext: ProviderContext;
  signal?: AbortSignal;
  isDownload?: boolean;
}

function headers(
  providerContext: ProviderContext,
  referer: string,
): Record<string, string> {
  return {
    ...providerContext.commonHeaders,
    "User-Agent":
      providerContext.commonHeaders?.["User-Agent"] ||
      providerContext.commonHeaders?.["user-agent"] ||
      FALLBACK_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/vnd.apple.mpegurl,*/*",
    Referer: referer,
  };
}

async function getText(
  providerContext: ProviderContext,
  url: string,
  referer: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await providerContext.axios.get(url, {
    signal,
    headers: headers(providerContext, referer),
  });
  return String(response.data || "");
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\bii\b/g, "2")
    .replace(/\biii\b/g, "3")
    .replace(/\biv\b/g, "4")
    .replace(/\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleScore(query: string, result: SearchResult): number {
  const wanted = normalizeTitle(query);
  const found = normalizeTitle(result.title);
  if (!wanted || !found) return -result.index;
  if (wanted === found) return 10_000 - result.index;
  let score = -result.index;
  if (wanted.includes(found) || found.includes(wanted)) score += 1_000;
  const wantedTokens = new Set(wanted.split(" "));
  const foundTokens = new Set(found.split(" "));
  for (const token of wantedTokens) {
    if (foundTokens.has(token)) score += token.length * 10;
  }
  const wantedSeason = wanted.match(/(?:season\s*)?(\d+)\s*$/)?.[1];
  const foundSeason = found.match(/(?:season\s*)?(\d+)\s*$/)?.[1];
  if (wantedSeason && foundSeason) {
    score += wantedSeason === foundSeason ? 500 : -1_000;
  }
  return score;
}

export function parseAniNekoSearch(
  html: string,
  providerContext: ProviderContext,
): SearchResult[] {
  const $ = providerContext.cheerio.load(html);
  const results: SearchResult[] = [];
  $("article.nv-anime-card").each((index, node) => {
    const anchor = $(node)
      .find("h3.nv-anime-title a, a.nv-anime-thumb")
      .first();
    const href = anchor.attr("href") || "";
    const title = clean(anchor.attr("title") || anchor.text());
    if (!href || !title || /(?:^|-)dub(?:-|$)/i.test(href)) return;
    results.push({
      title,
      link: new URL(href, ANINEKO_BASE).href,
      index,
    });
  });
  return results;
}

async function findShow(
  titles: string[],
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<SearchResult> {
  let best: { result: SearchResult; score: number } | undefined;
  for (const title of titles.map(clean).filter(Boolean)) {
    const url = new URL("/browser", ANINEKO_BASE);
    url.searchParams.set("keyword", title);
    const html = await getText(
      providerContext,
      url.href,
      `${ANINEKO_BASE}/`,
      signal,
    );
    for (const result of parseAniNekoSearch(html, providerContext)) {
      const score = titleScore(title, result);
      if (!best || score > best.score) best = { result, score };
    }
    if (best && best.score >= 10_000) break;
  }
  if (!best) throw new Error("AniNeko did not find this anime");
  return best.result;
}

export function parseAniNekoEpisodeLink(
  html: string,
  showUrl: string,
  episode: string | number,
  providerContext: ProviderContext,
): string {
  const wanted = Number(episode);
  const $ = providerContext.cheerio.load(html);
  let found = "";
  $("article.nv-info-episode-item a.nv-info-episode-main").each((_, node) => {
    const href = $(node).attr("href") || "";
    const number = Number(href.match(/\/ep-([\d.]+)/i)?.[1]);
    if (href && Number.isFinite(number) && Math.abs(number - wanted) < 0.001) {
      found = new URL(href, showUrl).href;
      return false;
    }
  });
  if (!found) throw new Error(`AniNeko episode ${episode} was unavailable`);
  return found;
}

export function parseAniNekoHardSubEmbeds(
  html: string,
  episodeUrl: string,
  providerContext: ProviderContext,
): EmbedResult[] {
  const $ = providerContext.cheerio.load(html);
  const embeds: EmbedResult[] = [];
  $('.nv-server-panel[data-id="hsub"] .nv-server-btn[data-video]').each(
    (_, node) => {
      const link = $(node).attr("data-video") || "";
      if (!link) return;
      const label = clean($(node).clone().children().remove().end().text());
      embeds.push({
        label: label || "H-Sub",
        link: new URL(link, episodeUrl).href,
      });
    },
  );
  return embeds.sort((left, right) => {
    const priority = (value: string): number => {
      if (/otakuhg\./i.test(value)) return 0;
      if (/otakuvid\./i.test(value)) return 1;
      if (/bibiemb\./i.test(value)) return 2;
      if (/vivibebe\./i.test(value)) return 3;
      return 10;
    };
    return priority(left.link) - priority(right.link);
  });
}

function absoluteMediaUrl(value: string, embedUrl: string): string {
  return new URL(
    value.replace(/\\\//g, "/").replace(/\\u0026/gi, "&"),
    embedUrl,
  ).href;
}

export function extractAniNekoEmbedSources(
  html: string,
  embedUrl: string,
): ExtractedSource[] {
  const sources: ExtractedSource[] = [];
  try {
    for (const unpacked of unpackAll(html)) {
      const duration = Number(
        unpacked.match(/\bduration\s*:\s*["']?([\d.]+)/i)?.[1],
      );
      for (const key of ["hls4", "hls3", "hls2"]) {
        const match = unpacked.match(
          new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)`, "i"),
        );
        if (match?.[1]) {
          sources.push({
            link: absoluteMediaUrl(match[1], embedUrl),
            duration: Number.isFinite(duration) && duration > 0
              ? duration
              : undefined,
          });
        }
      }
    }
  } catch {
    // Some hosts expose their source in plain JavaScript instead of a packer.
  }

  const plain = html
    .replace(/\\\//g, "/")
    .match(/https?:\/\/[^"'\s<>]+?\.(?:m3u8|mp4)(?:[?#][^"'\s<>]*)?/gi);
  for (const link of plain || []) sources.push({ link });

  const unique = new Set<string>();
  return sources.filter((source) => {
    if (unique.has(source.link)) return false;
    unique.add(source.link);
    return true;
  });
}

export function parseHlsVariants(playlist: string, masterUrl: string): HlsVariant[] {
  const lines = playlist.split(/\r?\n/).map((line) => line.trim());
  const variants: HlsVariant[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes("#EXT-X-STREAM-INF")) continue;
    const bandwidth = Number(line.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i)?.[1]);
    const quality =
      line.match(/RESOLUTION=\d+x(\d+)/i)?.[1] ||
      line.match(/(?:NAME=)?["']?(360|480|720|1080|2160)p/i)?.[1] ||
      "";
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next] || lines[next].startsWith("#")) continue;
      variants.push({
        link: new URL(lines[next], masterUrl).href,
        quality,
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0,
      });
      break;
    }
  }
  return variants;
}

function playlistDuration(playlist: string): number {
  return playlist
    .split(/\r?\n/)
    .filter((line) => line.startsWith("#EXTINF:"))
    .reduce((total, line) => {
      const value = Number(line.match(/^#EXTINF:([\d.]+)/)?.[1]);
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);
}

function sizeLabel(bandwidth: number, duration: number): string {
  if (!(bandwidth > 0) || !(duration > 0)) return "";
  const bytes = (bandwidth * duration) / 8;
  if (bytes >= 1_000_000_000) return `~${(bytes / 1_000_000_000).toFixed(2)} GB`;
  return `~${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

export function parseStreamHgDownloadSizes(
  html: string,
  providerContext: ProviderContext,
): DownloadSizes {
  const $ = providerContext.cheerio.load(html);
  const sizes: DownloadSizes = {};
  $("a.downloadv-item").each((_, node) => {
    const text = clean($(node).text());
    const quality = text.match(/\b\d{3,4}x(\d{3,4})\b/i)?.[1];
    const size = text.match(/\b([\d.]+\s*(?:KB|MB|GB|TB))\b/i)?.[1];
    if (quality && size) sizes[quality] = size.replace(/\s+/g, " ");
  });
  return sizes;
}

async function streamHgDownloadSizes(
  embed: EmbedResult,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<DownloadSizes> {
  if (!/otakuhg\./i.test(embed.link)) return {};
  const embedUrl = new URL(embed.link);
  const code = embedUrl.pathname.match(/\/e\/([^/?#]+)/i)?.[1];
  if (!code) return {};
  const downloadUrl = new URL(`/d/${code}`, embedUrl.origin).href;
  const html = await getText(
    providerContext,
    downloadUrl,
    embed.link,
    signal,
  );
  return parseStreamHgDownloadSizes(html, providerContext);
}

async function streamsFromSource(
  source: ExtractedSource,
  embed: EmbedResult,
  providerContext: ProviderContext,
  signal?: AbortSignal,
  isDownload?: boolean,
  downloadSizes: DownloadSizes = {},
): Promise<Stream[]> {
  if (/\.mp4(?:[?#]|$)/i.test(source.link)) {
    const quality = embed.label.match(/(360|480|720|1080|2160)/)?.[1] || "1080";
    const size = isDownload ? downloadSizes[quality] || "" : "";
    return [
      {
        server: `${embed.label} ${quality}p${size ? ` • ${size}` : ""}`,
        link: source.link,
        type: "mp4",
        quality,
        tag: "H-Sub",
        tags: ["H-Sub", "English Subbed", "Fast source"],
        headers: headers(providerContext, embed.link),
      },
    ];
  }

  const master = await getText(
    providerContext,
    source.link,
    embed.link,
    signal,
  );
  if (!master.startsWith("#EXTM3U")) {
    throw new Error(`${embed.label} returned an invalid HLS playlist`);
  }
  let variants = parseHlsVariants(master, source.link);
  if (!variants.length) {
    const quality = embed.label.match(/(360|480|720|1080|2160)/)?.[1] || "";
    variants = [{ link: source.link, quality, bandwidth: 0 }];
  }

  let duration = source.duration || 0;
  if (
    isDownload &&
    !duration &&
    variants[0] &&
    variants.some((variant) => !downloadSizes[variant.quality])
  ) {
    try {
      const media = await getText(
        providerContext,
        variants[0].link,
        embed.link,
        signal,
      );
      duration = playlistDuration(media);
    } catch (error) {
      console.log("AniNeko duration lookup failed", error);
    }
  }

  return variants.map((variant) => {
    const size = isDownload
      ? downloadSizes[variant.quality] || sizeLabel(variant.bandwidth, duration)
      : "";
    const qualitySuffix = variant.quality ? `${variant.quality}p` : "HLS";
    return {
      server: `${embed.label} ${qualitySuffix}${size ? ` • ${size}` : ""}`,
      link: variant.link,
      type: "m3u8",
      quality: variant.quality || undefined,
      tag: "H-Sub",
      tags: ["H-Sub", "English Subbed", "Fast source"],
      headers: headers(providerContext, embed.link),
    } satisfies Stream;
  });
}

export async function getAniNekoHardSubStreams({
  titles,
  episode,
  providerContext,
  signal,
  isDownload,
}: AniNekoHardSubRequest): Promise<Stream[]> {
  const show = await findShow(titles, providerContext, signal);
  const showHtml = await getText(
    providerContext,
    show.link,
    `${ANINEKO_BASE}/`,
    signal,
  );
  const episodeUrl = parseAniNekoEpisodeLink(
    showHtml,
    show.link,
    episode,
    providerContext,
  );
  const episodeHtml = await getText(
    providerContext,
    episodeUrl,
    show.link,
    signal,
  );
  const embeds = parseAniNekoHardSubEmbeds(
    episodeHtml,
    episodeUrl,
    providerContext,
  );
  if (!embeds.length) throw new Error("AniNeko had no Hard Sub servers");

  for (const embed of embeds) {
    try {
      let downloadSizes: DownloadSizes = {};
      if (isDownload) {
        try {
          downloadSizes = await streamHgDownloadSizes(
            embed,
            providerContext,
            signal,
          );
        } catch (error) {
          console.log("StreamHG exact size lookup failed", error);
        }
      }
      const embedHtml = await getText(
        providerContext,
        embed.link,
        episodeUrl,
        signal,
      );
      const sources = extractAniNekoEmbedSources(embedHtml, embed.link);
      for (const source of sources) {
        try {
          const streams = await streamsFromSource(
            source,
            embed,
            providerContext,
            signal,
            isDownload,
            downloadSizes,
          );
          if (streams.length) return streams;
        } catch (error) {
          console.log(`${embed.label} media source failed`, error);
        }
      }
    } catch (error) {
      console.log(`${embed.label} H-Sub embed failed`, error);
    }
  }
  throw new Error("AniNeko Hard Sub servers did not return playable media");
}
