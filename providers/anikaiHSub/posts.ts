import { Post, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  absoluteUrl,
  cleanText,
  getBaseUrl,
  getHtml,
  seriesTitleFromEpisode,
} from "./client";

function pageUrl(baseUrl: string, filter: string, page: number): string {
  const path = filter || "/";
  if (page <= 1) return absoluteUrl(path, baseUrl);
  const trimmed = path.replace(/\/+$/, "");
  return absoluteUrl(`${trimmed}/page/${page}/`, baseUrl);
}

export function parsePosts(
  html: string,
  pageAddress: string,
  providerContext: ProviderContext,
): Post[] {
  const $ = providerContext.cheerio.load(html);
  const posts: Post[] = [];
  const seen = new Set<string>();
  const cards = $(".listupd article.bs, .listupd .bsx, article.bs");

  cards.each((_, element) => {
    const card = $(element);
    const anchor = card.is("a[href]") ? card : card.find("a[href]").first();
    const href = anchor.attr("href") || "";
    const imageNode = card.find("img").first();
    const image =
      imageNode.attr("data-src") ||
      imageNode.attr("data-lazy-src") ||
      imageNode.attr("src") ||
      "";
    if (!href || !image) return;

    const link = absoluteUrl(href, pageAddress);
    if (seen.has(link)) return;

    const headline =
      card.find("h2").first().text() ||
      anchor.attr("title") ||
      imageNode.attr("alt") ||
      "";
    const title = seriesTitleFromEpisode(headline);
    if (!title) return;

    const episode = cleanText(card.find(".epx").first().text());
    seen.add(link);
    posts.push({
      title,
      link,
      image: absoluteUrl(image, pageAddress),
      provider: "anikaiHSub",
      tag: episode && !/^ongoing$/i.test(episode) ? `${episode} • H-Sub` : "H-Sub",
    });
  });

  return posts;
}

async function fetchPosts({
  filter,
  page,
  searchQuery,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  searchQuery?: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const baseUrl = await getBaseUrl(providerContext);
  const url = searchQuery
    ? `${baseUrl}/${page > 1 ? `page/${page}/` : ""}?s=${encodeURIComponent(searchQuery)}`
    : pageUrl(baseUrl, filter, page);
  const html = await getHtml(providerContext, url, signal);
  return parsePosts(html, url, providerContext);
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
    return await fetchPosts({ filter, page, signal, providerContext });
  } catch (error) {
    throwProviderError("Anikai H-Sub", "catalog", error);
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
    return await fetchPosts({
      filter: "/",
      page,
      searchQuery: searchQuery.trim(),
      signal,
      providerContext,
    });
  } catch (error) {
    throwProviderError("Anikai H-Sub", "search", error);
  }
}
