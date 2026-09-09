import { Info, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { absoluteUrl, cleanText, getBaseUrl, getHtml } from "./client";

async function resolveSeriesPage(
  link: string,
  providerContext: ProviderContext,
): Promise<{ url: string; html: string }> {
  const baseUrl = await getBaseUrl(providerContext);
  let url = absoluteUrl(link, baseUrl);
  let html = await getHtml(providerContext, url);
  if (new URL(url).pathname.includes("/series/")) return { url, html };

  const $ = providerContext.cheerio.load(html);
  const seriesLink = $(
    '.ts-breadcrumb a[href*="/series/"], .single-info a[href*="/series/"]',
  )
    .first()
    .attr("href");
  if (seriesLink) {
    url = absoluteUrl(seriesLink, baseUrl);
    html = await getHtml(providerContext, url);
  }
  return { url, html };
}

function fieldValue($: any, label: string): string {
  const labelLower = label.toLowerCase();
  let value = "";
  $(".animefull .spe span").each((_: number, node: any) => {
    const text = cleanText($(node).text());
    if (text.toLowerCase().startsWith(`${labelLower}:`)) {
      value = cleanText(text.slice(text.indexOf(":") + 1));
    }
  });
  return value;
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
    const page = await resolveSeriesPage(link, providerContext);
    const $ = providerContext.cheerio.load(page.html);
    const imageValue =
      $(".animefull .thumbook .thumb img").first().attr("src") ||
      $('meta[property="og:image"]').attr("content") ||
      "";
    const title = cleanText(
      $(".animefull h1.entry-title, h1.entry-title").first().text(),
    );
    const synopsis = cleanText(
      $(".synp .entry-content").first().text() ||
        $(".animefull .desc").first().text(),
    );
    const tags = $(".animefull .genxed a")
      .map((_: number, node: any) => cleanText($(node).text()))
      .get()
      .filter(Boolean);
    const rating =
      $('meta[itemprop="ratingValue"]').first().attr("content") || "";
    const sourceType = fieldValue($, "Type");
    const directLinks = $(".epcheck .eplister li a, .eplister li a")
      .map((_: number, node: any) => {
        const row = $(node);
        const href = row.attr("href") || "";
        const episodeNumber = cleanText(row.find(".epl-num").text());
        const episodeTitle = cleanText(row.find(".epl-title").text());
        if (!href) return null;
        return {
          title: episodeNumber ? `Episode ${episodeNumber}` : episodeTitle,
          link: absoluteUrl(href, page.url),
          type: "series" as const,
          description: cleanText(row.find(".epl-date").text()) || "English H-Sub",
          image: imageValue ? absoluteUrl(imageValue, page.url) : undefined,
        };
      })
      .get()
      .filter(Boolean);

    if (!title || !imageValue) {
      throw new Error("Series metadata was missing from the page");
    }

    return {
      title,
      image: absoluteUrl(imageValue, page.url),
      synopsis,
      imdbId: "",
      type: /movie|film/i.test(sourceType) ? "movie" : "series",
      tags: [...tags, "H-Sub", "English Subbed"],
      rating,
      linkList: [
        directLinks.length
          ? { title: "Episodes", directLinks }
          : { title: "Episodes", episodesLink: page.url },
      ],
      webUrl: page.url,
    };
  } catch (error) {
    throwProviderError("Anikai H-Sub", "metadata", error);
  }
}
