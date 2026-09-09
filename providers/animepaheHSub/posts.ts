import { Post, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  AnimeReference,
  cacheReference,
  getApiPage,
  getBaseUrl,
  makeAnimeLink,
} from "./client";

interface AiringItem {
  anime_id: number;
  anime_session: string;
  anime_title: string;
  snapshot: string;
  fansub?: string;
}

interface SearchItem {
  id: number;
  title: string;
  poster: string;
  session: string;
}

async function toPost(
  providerContext: ProviderContext,
  baseUrl: string,
  reference: AnimeReference,
  image: string,
  detail?: string,
): Promise<Post> {
  await cacheReference(providerContext, reference);
  return {
    title: reference.title,
    link: makeAnimeLink(baseUrl, reference),
    image,
    provider: "animepaheHSub",
    tag: detail ? `${detail} • H-Sub` : "H-Sub",
  };
}

export async function getPosts({
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
    const baseUrl = await getBaseUrl(providerContext);
    const url = new URL("/api", baseUrl);
    url.searchParams.set("m", "airing");
    url.searchParams.set("page", String(Math.max(1, page)));
    const result = await getApiPage<AiringItem>(
      providerContext,
      url.href,
      signal,
    );
    return Promise.all(
      result.data.map((item) =>
        toPost(
          providerContext,
          baseUrl,
          {
            id: String(item.anime_id),
            session: item.anime_session,
            title: item.anime_title,
          },
          item.snapshot,
          item.fansub,
        ),
      ),
    );
  } catch (error) {
    throwProviderError("AnimePahe H-Sub", "catalog", error);
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
    const baseUrl = await getBaseUrl(providerContext);
    const url = new URL("/api", baseUrl);
    url.searchParams.set("m", "search");
    url.searchParams.set(
      "q",
      `${query} ${Math.floor(Date.now() / 1000) + Math.max(1, page) * 3}`,
    );
    url.searchParams.set("page", String(Math.max(1, page)));
    const result = await getApiPage<SearchItem>(
      providerContext,
      url.href,
      signal,
    );
    return Promise.all(
      result.data.map((item) =>
        toPost(
          providerContext,
          baseUrl,
          {
            id: String(item.id),
            session: item.session,
            title: item.title,
          },
          item.poster,
        ),
      ),
    );
  } catch (error) {
    throwProviderError("AnimePahe H-Sub", "search", error);
  }
}
