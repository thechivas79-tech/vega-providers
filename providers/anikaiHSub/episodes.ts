import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { absoluteUrl, cleanText, getBaseUrl, getHtml } from "./client";

export async function getEpisodes({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  try {
    const baseUrl = await getBaseUrl(providerContext);
    const pageUrl = absoluteUrl(url, baseUrl);
    const html = await getHtml(providerContext, pageUrl);
    const $ = providerContext.cheerio.load(html);
    const fallbackImage =
      $(".animefull .thumbook img").first().attr("src") || "";
    const episodes: EpisodeLink[] = [];
    const seen = new Set<string>();

    $(".epcheck .eplister li a, .eplister li a").each((_, node) => {
      const row = $(node);
      const href = row.attr("href") || "";
      if (!href) return;
      const link = absoluteUrl(href, pageUrl);
      if (seen.has(link)) return;

      const episodeNumber = cleanText(row.find(".epl-num").text());
      const fullTitle = cleanText(row.find(".epl-title").text());
      const date = cleanText(row.find(".epl-date").text());
      seen.add(link);
      episodes.push({
        title: episodeNumber ? `Episode ${episodeNumber}` : fullTitle,
        link,
        description: date || "English H-Sub",
        image: fallbackImage ? absoluteUrl(fallbackImage, pageUrl) : undefined,
      });
    });

    return episodes;
  } catch (error) {
    throwProviderError("Anikai H-Sub", "episodes", error);
  }
}
