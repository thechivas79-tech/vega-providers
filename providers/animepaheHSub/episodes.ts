import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  cacheReference,
  findReference,
  getApiPage,
  getBaseUrl,
  parseAnimeLink,
} from "./client";

interface EpisodeItem {
  created_at: string;
  session: string;
  episode: number;
  anime_id: number;
}

function episodeTitle(value: number): string {
  const number = Number(value);
  return `Episode ${Number.isInteger(number) ? number.toFixed(0) : number}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getEpisodes({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  try {
    const baseUrl = await getBaseUrl(providerContext);
    let reference = parseAnimeLink(url, baseUrl);
    reference.session =
      reference.session ||
      (reference.id
        ? (await providerContext.kvStore.get<string>(
            `animepahe.session.${reference.id}`,
          )) || ""
        : "");
    if (!reference.session) {
      reference =
        (await findReference(
          providerContext,
          reference.id,
          reference.title,
        )) || reference;
    }
    if (!reference.session) throw new Error("Anime session was unavailable");

    const episodes: EpisodeLink[] = [];
    let page = 1;
    let lastPage = 1;
    do {
      const apiUrl = new URL("/api", baseUrl);
      apiUrl.searchParams.set("m", "release");
      apiUrl.searchParams.set("id", reference.session);
      apiUrl.searchParams.set("sort", "episode_asc");
      apiUrl.searchParams.set("page", String(page));
      const result = await getApiPage<EpisodeItem>(providerContext, apiUrl.href);
      lastPage = result.last_page;
      for (const episode of result.data) {
        const play = new URL(
          `/play/${reference.session}/${episode.session}`,
          baseUrl,
        );
        play.searchParams.set("anime_id", String(episode.anime_id));
        episodes.push({
          title: episodeTitle(episode.episode),
          link: play.href,
          description: episode.created_at || "English H-Sub",
        });
      }
      if (result.data[0]) {
        reference.id = String(result.data[0].anime_id);
        await cacheReference(providerContext, reference);
      }
      page += 1;
      if (page <= lastPage) await wait(750);
    } while (page <= lastPage);

    return episodes.reverse();
  } catch (error) {
    throwProviderError("AnimePahe H-Sub", "episodes", error);
  }
}
