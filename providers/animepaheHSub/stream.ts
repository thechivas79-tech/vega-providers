import { ProviderContext, Stream } from "../types";
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

function qualityOf(value?: string | number): string {
  return String(value || "").match(/(360|480|720|1080|2160)/)?.[1] || "";
}

function sortStreams(streams: Stream[], preferred: string): Stream[] {
  return streams.sort((left, right) => {
    const leftPreferred = left.quality === preferred ? 1 : 0;
    const rightPreferred = right.quality === preferred ? 1 : 0;
    return (
      rightPreferred - leftPreferred ||
      Number(right.quality || 0) - Number(left.quality || 0)
    );
  });
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
      ["1080", "720", "480"];

    let streams: Stream[] = [];
    if (isDownload) {
      try {
        streams = await downloadStreams(
          animeId,
          episode,
          providerContext,
          signal,
        );
      } catch (error) {
        console.log("AnimeGG signed download source failed", error);
      }
    }
    if (!streams.length) {
      streams = await playbackStreams(
        animeId,
        episode,
        providerContext,
        signal,
      );
    }

    const filtered = streams.filter(
      (stream) => !stream.quality || allowed.includes(stream.quality),
    );
    if (!filtered.length) {
      throw new Error("No allowed AnimeGG H-Sub streams were available");
    }
    return sortStreams(filtered, preferred);
  } catch (error) {
    throwProviderError("AnimeGG H-Sub 1080", "stream", error);
  }
}
