import { Post, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  AnimeCard,
  animeImage,
  animeTitle,
  getApi,
  makeAnimeLink,
} from "./client";

interface HomeResponse {
  trending?: AnimeCard[];
  popular?: AnimeCard[];
  airing?: AnimeCard[];
  latestEpisode?: AnimeCard[];
}

interface SearchResponse {
  results?: AnimeCard[];
}

function toPost(item: AnimeCard): Post {
  const details = [
    item.latestEpisode ? `Episode ${item.latestEpisode}` : "",
    "Native",
    "up to 1080p",
  ].filter(Boolean);
  return {
    title: animeTitle(item.title),
    link: makeAnimeLink(item.id),
    image: animeImage(item),
    provider: "animepaheHSub",
    tag: details.join(" • "),
  };
}

export async function getPosts({
  filter,
  page,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  try {
    if (Math.max(1, Number(page) || 1) > 1) return [];
    const home = await getApi<HomeResponse>(providerContext, "/home", signal);
    const key = ["trending", "popular", "airing", "latestEpisode"].includes(
        filter,
      )
      ? (filter as keyof HomeResponse)
      : "latestEpisode";
    return (home[key] || []).map(toPost).filter((post) => post.image);
  } catch (error) {
    throwProviderError("Anime H-Sub 1080", "catalog", error);
  }
}

export async function getSearchPosts({
  searchQuery,
  page,
  signal,
  providerContext,
}: {
  searchQuery: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  try {
    const query = searchQuery.trim();
    if (!query) return [];
    const path = `/search?query=${encodeURIComponent(query)}&page=${Math.max(1, Number(page) || 1)}`;
    const result = await getApi<SearchResponse>(providerContext, path, signal);
    return (result.results || []).map(toPost).filter((post) => post.image);
  } catch (error) {
    throwProviderError("Anime H-Sub 1080", "search", error);
  }
}
