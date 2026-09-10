import {
  ProviderContext,
  SkipInterval,
  Stream,
  TextTracks,
} from "../types";
import { throwProviderError } from "../providerErrors";
import { getApi, parseEpisodeLink } from "./client";

interface AnimeGgSource {
  url: string;
  quality?: string;
  isM3U8?: boolean;
  headers?: Record<string, string>;
}

interface AnimeGgPlayback {
  sub?: {
    sources?: AnimeGgSource[];
  } | null;
}

interface AnimeGgDownload {
  quality?: string;
  resolution?: number;
  filesize?: string;
  download?: string;
}

interface AnimeGgDownloads {
  downloads?: AnimeGgDownload[];
}

interface SubtitleTrack {
  file?: string;
  label?: string;
  kind?: string;
}

interface TimeRange {
  start?: number;
  end?: number;
}

interface SoftSubPlayback {
  sub?: {
    sources?: AnimeGgSource[];
    subtitles?: SubtitleTrack[];
    headers?: Record<string, string>;
    intro?: TimeRange | null;
    outro?: TimeRange | null;
  } | null;
}

function qualityOf(value?: string | number): string {
  return String(value || "").match(/(360|480|720|1080|2160)/)?.[1] || "";
}

function sortStreams(streams: Stream[], preferred: string): Stream[] {
  return streams.sort((left, right) => {
    const leftPreferred = left.quality === preferred ? 1 : 0;
    const rightPreferred = right.quality === preferred ? 1 : 0;
    const leftHardSub = left.tags?.includes("H-Sub") ? 1 : 0;
    const rightHardSub = right.tags?.includes("H-Sub") ? 1 : 0;
    return (
      rightPreferred - leftPreferred ||
      rightHardSub - leftHardSub ||
      Number(right.quality || 0) - Number(left.quality || 0)
    );
  });
}

function languageOf(label: string): string {
  const value = label.toLowerCase();
  if (value.includes("english")) return "en";
  if (value.includes("portuguese")) return "pt";
  if (value.includes("spanish")) return "es";
  if (value.includes("french")) return "fr";
  if (value.includes("german")) return "de";
  if (value.includes("italian")) return "it";
  if (value.includes("russian")) return "ru";
  if (value.includes("arabic")) return "ar";
  return "und";
}

function subtitleTracks(items?: SubtitleTrack[]): TextTracks {
  return (items || [])
    .filter((item) => item.file && item.kind !== "thumbnails")
    .map((item) => {
      const title = String(item.label || "Subtitles");
      return {
        title,
        language: languageOf(title),
        type: "text/vtt" as const,
        uri: String(item.file),
      };
    });
}

function skipIntervals(intro?: TimeRange | null, outro?: TimeRange | null): SkipInterval[] {
  const ranges: SkipInterval[] = [];
  if (Number(intro?.end) > Number(intro?.start)) {
    ranges.push({
      title: "Intro",
      from: Number(intro?.start),
      to: Number(intro?.end),
    });
  }
  if (Number(outro?.end) > Number(outro?.start)) {
    ranges.push({
      title: "Outro",
      from: Number(outro?.start),
      to: Number(outro?.end),
    });
  }
  return ranges;
}

async function downloadStreams(
  animeId: string,
  episode: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<Stream[]> {
  const result = await getApi<AnimeGgDownloads>(
    providerContext,
    `/watch/${encodeURIComponent(animeId)}/episode/${encodeURIComponent(episode)}/download/animegg`,
    signal,
  );
  return (result.downloads || [])
    .filter((item) => item.download)
    .map((item) => {
      const quality = qualityOf(item.resolution || item.quality);
      return {
        server: `AnimeGG Download ${quality ? `${quality}p` : "MP4"}${item.filesize ? ` • ${item.filesize}` : ""}`,
        link: String(item.download),
        type: "mp4",
        quality: quality || undefined,
        tag: "H-Sub",
        tags: ["H-Sub", "English Subbed", "Download"],
      } satisfies Stream;
    });
}

async function playbackStreams(
  animeId: string,
  episode: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<Stream[]> {
  const result = await getApi<AnimeGgPlayback>(
    providerContext,
    `/watch/${encodeURIComponent(animeId)}/episode/${encodeURIComponent(episode)}/animegg`,
    signal,
  );
  return (result.sub?.sources || [])
    .filter((source) => source.url)
    .map((source) => {
      const quality = qualityOf(source.quality);
      return {
        server: `AnimeGG ${quality ? `${quality}p` : "H-Sub"}`,
        link: source.url,
        type: source.isM3U8 || /\.m3u8(?:[?#]|$)/i.test(source.url)
          ? "m3u8"
          : "mp4",
        quality: quality || undefined,
        tag: "H-Sub",
        tags: ["H-Sub", "English Subbed"],
        headers: {
          ...providerContext.commonHeaders,
          ...(source.headers || {}),
        },
      } satisfies Stream;
    });
}

async function expandHlsSource(
  source: AnimeGgSource,
  headers: Record<string, string>,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<Array<{ link: string; type: string; quality: string }>> {
  const explicit = qualityOf(source.quality);
  if (!source.isM3U8 && !/\.m3u8(?:[?#]|$)/i.test(source.url)) {
    return [{ link: source.url, type: "mp4", quality: explicit }];
  }
  try {
    const response = await providerContext.axios.get(source.url, {
      signal,
      headers,
    });
    const playlist = String(response.data || "");
    const lines = playlist.split(/\r?\n/).map((line) => line.trim());
    const variants: Array<{ link: string; type: string; quality: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes("#EXT-X-STREAM-INF")) continue;
      const quality = qualityOf(lines[index]);
      for (let next = index + 1; next < lines.length; next += 1) {
        if (!lines[next] || lines[next].startsWith("#")) continue;
        variants.push({
          link: new URL(lines[next], source.url).href,
          type: "m3u8",
          quality,
        });
        break;
      }
    }
    if (variants.length) return variants;
  } catch (error) {
    console.log("Fallback HLS quality detection failed", error);
  }
  return [{ link: source.url, type: "m3u8", quality: explicit }];
}

async function softSubFallbackStreams(
  animeId: string,
  episode: string,
  route: "megaplay" | "zokoanime",
  label: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<Stream[]> {
  const result = await getApi<SoftSubPlayback>(
    providerContext,
    `/watch/${encodeURIComponent(animeId)}/episode/${encodeURIComponent(episode)}/${route}`,
    signal,
  );
  const group = result.sub;
  if (!group) return [];
  const tracks = subtitleTracks(group.subtitles);
  const skip = skipIntervals(group.intro, group.outro);
  const streams: Stream[] = [];
  for (const source of group.sources || []) {
    if (!source.url) continue;
    const headers = {
      ...providerContext.commonHeaders,
      ...(group.headers || {}),
      ...(source.headers || {}),
    };
    const variants = await expandHlsSource(
      source,
      headers,
      providerContext,
      signal,
    );
    for (const variant of variants) {
      streams.push({
        server: `${label} ${variant.quality ? `${variant.quality}p` : "Auto"} • Soft-Sub fallback`,
        link: variant.link,
        type: variant.type,
        quality: variant.quality || undefined,
        tag: "Soft-Sub fallback",
        tags: ["Soft-Sub", "English Subtitles", "Fallback"],
        headers,
        subtitles: tracks,
        skip: skip.length ? skip : undefined,
      });
    }
  }
  return streams;
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
    const { animeId, episode } = parseEpisodeLink(link);
    if (!animeId || !episode) throw new Error("Episode link was incomplete");
    const preferred =
      (await providerContext.kvStore.get<string>("preferredQuality")) ||
      "1080";
    const allowed =
      (await providerContext.kvStore.get<string[]>("allowedResolutions")) ||
      ["1080", "720", "480", "360"];

    let streams: Stream[] = [];
    let primaryError: unknown;
    if (isDownload) {
      try {
        streams = await downloadStreams(
          animeId,
          episode,
          providerContext,
          signal,
        );
      } catch (error) {
        primaryError = error;
        console.log("AnimeGG signed download source failed", error);
      }
    }
    if (!streams.length) {
      try {
        streams = await playbackStreams(
          animeId,
          episode,
          providerContext,
          signal,
        );
      } catch (error) {
        primaryError = error;
        console.log("AnimeGG playback source failed", error);
      }
    }
    if (!streams.length) {
      for (const [route, label] of [
        ["megaplay", "MegaPlay"],
        ["zokoanime", "Zoko"],
      ] as const) {
        try {
          streams = await softSubFallbackStreams(
            animeId,
            episode,
            route,
            label,
            providerContext,
            signal,
          );
          if (streams.length) break;
        } catch (error) {
          console.log(`${label} fallback source failed`, error);
        }
      }
    }

    const filtered = streams.filter(
      (stream) => !stream.quality || allowed.includes(stream.quality),
    );
    if (!filtered.length) {
      if (primaryError) {
        throw new Error(
          "AnimeGG had no file and the native 1080p fallbacks were unavailable",
        );
      }
      throw new Error("No allowed native 1080p streams were available");
    }
    return sortStreams(filtered, preferred);
  } catch (error) {
    throwProviderError("Anime 1080 Native", "stream", error);
  }
}
