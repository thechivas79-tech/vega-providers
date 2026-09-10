import { ProviderContext } from "../types";

export const DEFAULT_API_BASE = "https://core.justanime.to/api";
export const SITE_BASE = "https://justanime.to";

export interface AnimeTitle {
  english?: string | null;
  romaji?: string | null;
}

export interface AnimeCard {
  id: number;
  title: AnimeTitle;
  cover?: string;
  coverImage?: { extraLarge?: string; large?: string } | string;
  bannerImage?: string;
  episodes?: number;
  latestEpisode?: number;
  type?: string;
  format?: string;
  year?: number | null;
  seasonYear?: number | null;
}

export function animeTitle(value?: AnimeTitle): string {
  return String(value?.english || value?.romaji || "Unknown Anime").trim();
}

export function animeImage(value: AnimeCard): string {
  if (typeof value.coverImage === "string") return value.coverImage;
  return String(
    value.cover ||
      value.coverImage?.extraLarge ||
      value.coverImage?.large ||
      value.bannerImage ||
      "",
  );
}

export async function getApiBase(
  providerContext: ProviderContext,
): Promise<string> {
  const override = await providerContext.kvStore.get<string>("apiBaseUrl");
  return (override || DEFAULT_API_BASE).trim().replace(/\/+$/, "");
}

function apiHeaders(
  providerContext: ProviderContext,
): Record<string, string> {
  return {
    ...providerContext.commonHeaders,
    Accept: "application/json, text/plain, */*",
    Origin: SITE_BASE,
    Referer: `${SITE_BASE}/`,
  };
}

export async function getApi<T>(
  providerContext: ProviderContext,
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const baseUrl = await getApiBase(providerContext);
  const url = new URL(path.replace(/^\/+/, ""), `${baseUrl}/`);
  const response = await providerContext.axios.get(url.href, {
    signal,
    headers: apiHeaders(providerContext),
  });
  const value = typeof response.data === "string"
    ? JSON.parse(response.data)
    : response.data;
  if (value?.error) {
    throw new Error(String(value.error?.message || value.error));
  }
  return value as T;
}

export function makeAnimeLink(id: number | string): string {
  return `${SITE_BASE}/anime/${encodeURIComponent(String(id))}`;
}

export function makeEpisodeLink(
  animeId: number | string,
  episode: number | string,
): string {
  return `${SITE_BASE}/watch/${encodeURIComponent(String(animeId))}/episode/${encodeURIComponent(String(episode))}`;
}

export function parseAnimeId(value: string): string {
  const url = new URL(value, `${SITE_BASE}/`);
  return (
    url.pathname.match(/\/anime\/(\d+)/)?.[1] ||
    url.pathname.match(/\/watch\/(\d+)/)?.[1] ||
    url.searchParams.get("animeId") ||
    ""
  );
}

export function parseEpisodeLink(value: string): {
  animeId: string;
  episode: string;
} {
  const url = new URL(value, `${SITE_BASE}/`);
  return {
    animeId:
      url.pathname.match(/\/watch\/(\d+)/)?.[1] ||
      url.searchParams.get("animeId") ||
      "",
    episode:
      url.pathname.match(/\/episode\/([\d.]+)/)?.[1] ||
      url.searchParams.get("episode") ||
      "",
  };
}
