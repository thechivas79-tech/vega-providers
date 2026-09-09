import { Info, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  absoluteUrl,
  cacheReference,
  cleanText,
  findReference,
  getAnimePaheHtml,
  getBaseUrl,
  makeAnimeLink,
  parseAnimeLink,
} from "./client";
import { getEpisodes } from "./episodes";

async function loadDetails(
  link: string,
  providerContext: ProviderContext,
): Promise<{ html: string; reference: ReturnType<typeof parseAnimeLink> }> {
  const baseUrl = await getBaseUrl(providerContext);
  let reference = parseAnimeLink(link, baseUrl);
  if (!reference.session && reference.id) {
    reference.session =
      (await providerContext.kvStore.get<string>(
        `animepahe.session.${reference.id}`,
      )) || "";
  }
  if (!reference.session) {
    reference =
      (await findReference(
        providerContext,
        reference.id,
        reference.title,
      )) || reference;
  }
  if (!reference.session) throw new Error("Anime session was unavailable");

  try {
    const html = await getAnimePaheHtml(
      providerContext,
      `${baseUrl}/anime/${reference.session}`,
    );
    if (!/title-wrapper|anime-content/i.test(html)) {
      throw new Error("The saved AnimePahe session expired");
    }
    return { html, reference };
  } catch (firstError) {
    const refreshed = await findReference(
      providerContext,
      reference.id,
      reference.title,
    );
    if (!refreshed || refreshed.session === reference.session) throw firstError;
    return {
      html: await getAnimePaheHtml(
        providerContext,
        `${baseUrl}/anime/${refreshed.session}`,
      ),
      reference: refreshed,
    };
  }
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
    const baseUrl = await getBaseUrl(providerContext);
    const page = await loadDetails(link, providerContext);
    const $ = providerContext.cheerio.load(page.html);
    const title = cleanText($("div.title-wrapper > h1 > span").first().text()) ||
      page.reference.title;
    const imageValue =
      $("div.anime-poster a[href]").first().attr("href") ||
      $("div.anime-poster img").first().attr("data-src") ||
      $("div.anime-poster img").first().attr("src") ||
      "";
    const synopsis = cleanText($("div.anime-summary").first().text());
    const pageId = $("meta[name=id]").attr("content") || page.reference.id;
    const reference = {
      id: pageId,
      session: page.reference.session,
      title,
    };
    await cacheReference(providerContext, reference);

    const tags = $(
      "div.anime-genre ul li, " +
        "div.col-sm-4.anime-info p:contains(Demographic:) a, " +
        "div.col-sm-4.anime-info p:contains(Theme:) a",
    )
      .map((_: number, node: any) => cleanText($(node).text()))
      .get()
      .filter(Boolean);
    let type = "series";
    $("div.col-sm-4.anime-info p").each((_: number, node: any) => {
      const text = cleanText($(node).text());
      if (/^type:/i.test(text) && /movie|film/i.test(text)) type = "movie";
    });

    if (!title || !imageValue) {
      throw new Error("Anime metadata was missing from the page");
    }
    const stableLink = makeAnimeLink(baseUrl, reference);
    const episodes = await getEpisodes({ url: stableLink, providerContext });
    return {
      title,
      image: absoluteUrl(imageValue, baseUrl),
      synopsis,
      imdbId: "",
      type,
      tags: [...tags, "H-Sub", "English Subbed"],
      linkList: [
        episodes.length
          ? {
              title: "Episodes",
              directLinks: episodes.map((episode) => ({
                ...episode,
                type: "series" as const,
              })),
            }
          : { title: "Episodes", episodesLink: stableLink },
      ],
      webUrl: `${baseUrl}/anime/${reference.session}`,
    };
  } catch (error) {
    throwProviderError("AnimePahe H-Sub", "metadata", error);
  }
}
