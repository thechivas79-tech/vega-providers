import { Info, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  AnimeCard,
  SITE_BASE,
  animeImage,
  animeTitle,
  getApi,
  makeAnimeLink,
  makeEpisodeLink,
  parseAnimeId,
} from "./client";

interface AnimeDetails extends AnimeCard {
  description?: string;
  genres?: string[];
  idMal?: number;
  characters?: Array<{ node?: { name?: string } }>;
}

function cleanSynopsis(html: string, providerContext: ProviderContext): string {
  const $ = providerContext.cheerio.load(`<div id="synopsis">${html}</div>`);
  return $("#synopsis").text().replace(/\s+/g, " ").trim();
}

export async function getMeta({
  link,
  providerContext,
}: {
  link: string;
  provider?: string;
  providerContext: ProviderContext;
}): Promise<Info> {
  try {
    const id = parseAnimeId(link);
    if (!id) throw new Error("Anime ID was missing");
    const response = await getApi<{ data?: AnimeDetails } | AnimeDetails>(
      providerContext,
      `/anime/${encodeURIComponent(id)}`,
    );
    const anime = ((response as { data?: AnimeDetails }).data ||
      response) as AnimeDetails;
    const title = animeTitle(anime.title);
    const image = animeImage(anime);
    if (!title || !image) throw new Error("Anime metadata was incomplete");

    const isMovie = String(anime.format || anime.type || "").toUpperCase() ===
      "MOVIE";
    const stableLink = makeAnimeLink(id);
    return {
      title,
      image,
      poster: image,
      synopsis: cleanSynopsis(anime.description || "", providerContext),
      imdbId: "",
      type: isMovie ? "movie" : "series",
      tags: [
        ...(anime.genres || []),
        "1080p",
        "H-Sub when available",
        "Soft-Sub fallback",
      ],
      cast: (anime.characters || [])
        .map((entry) => String(entry.node?.name || "").trim())
        .filter(Boolean),
      linkList: isMovie
        ? [
            {
              title: "Movie",
              quality: "1080p",
              directLinks: [
                {
                  title: "Movie",
                  link: makeEpisodeLink(id, 1),
                  type: "movie" as const,
                },
              ],
            },
          ]
        : [{ title: "Episodes", episodesLink: stableLink }],
      webUrl: `${SITE_BASE}/anime/${id}`,
    };
  } catch (error) {
    throwProviderError("Anime 1080 Native", "metadata", error);
  }
}
