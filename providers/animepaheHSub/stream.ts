import { ProviderContext, Stream } from "../types";
import { throwProviderError } from "../providerErrors";
import { getAniNekoHardSubStreams } from "../extractors/anineko";
import { AnimeTitle, getApi, parseEpisodeLink } from "./client";

interface AnimeGgSource {
  url: string;
  quality?: string;
  isM3U8?: boolean;
  headers?: Record<string, string>;
}

interface AnimeGgPlayback {
  sub?: { sources?: AnimeGgSource[] } | null;
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

interface AnimeDetails {
  title?: AnimeTitle;
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
        server: `AnimeGG ${quality ? `${quality}p` : "MP4"}${item.filesize ? ` • ${item.filesize}` : ""}`,
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

async function titleCandidates(
  animeId: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await getApi<{ data?: AnimeDetails } | AnimeDetails>(
    providerContext,
    `/anime/${encodeURIComponent(animeId)}`,
    signal,
  );
  const anime = ((response as { data?: AnimeDetails }).data ||
    response) as AnimeDetails;
  return [anime.title?.english, anime.title?.romaji]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
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
      try {
        streams = await getAniNekoHardSubStreams({
          titles: await titleCandidates(animeId, providerContext, signal),
          episode,
          providerContext,
          signal,
          isDownload,
        });
      } catch (error) {
        console.log("AniNeko 1080p H-Sub fallback failed", error);
      }
    }

    const filtered = streams.filter(
      (stream) => !stream.quality || allowed.includes(stream.quality),
    );
    if (!filtered.length) {
      if (primaryError) {
        throw new Error(
          "AnimeGG had no file and the 1080p Hard Sub mirror was unavailable",
        );
      }
      throw new Error("No allowed Hard Sub streams were available");
    }
    return sortStreams(filtered, preferred);
  } catch (error) {
    throwProviderError("Anime H-Sub 1080", "stream", error);
  }
}
