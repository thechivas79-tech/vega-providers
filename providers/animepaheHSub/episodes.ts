import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { getApi, makeEpisodeLink, parseAnimeId } from "./client";

interface ApiEpisode {
  number: number;
  title?: string;
  airDate?: string;
}

interface EpisodePage {
  totalPages?: number;
  episodes?: ApiEpisode[];
}

async function pageOf(
  providerContext: ProviderContext,
  id: string,
  page: number,
): Promise<EpisodePage> {
  return getApi<EpisodePage>(
    providerContext,
    `/anime/${encodeURIComponent(id)}/episodes?page=${page}`,
  );
}

export async function getEpisodes({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  try {
    const id = parseAnimeId(url);
    if (!id) throw new Error("Anime ID was missing");
    const first = await pageOf(providerContext, id, 1);
    const totalPages = Math.max(1, Number(first.totalPages) || 1);
    const remaining = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, index) =>
        pageOf(providerContext, id, index + 2),
      ),
    );
    const episodes = [first, ...remaining]
      .flatMap((page) => page.episodes || [])
      .filter((episode) => Number(episode.number) > 0)
      .sort((left, right) => Number(right.number) - Number(left.number));

    return episodes.map((episode) => ({
      title:
        episode.title && !/^episode\s+[\d.]+$/i.test(episode.title)
          ? `Episode ${episode.number} — ${episode.title}`
          : `Episode ${episode.number}`,
      link: makeEpisodeLink(id, episode.number),
      description: episode.airDate || "English H-Sub",
    }));
  } catch (error) {
    throwProviderError("AnimeGG H-Sub 1080", "episodes", error);
  }
}
