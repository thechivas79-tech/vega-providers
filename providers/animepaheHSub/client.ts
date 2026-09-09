import { ProviderContext } from "../types";

export const DEFAULT_BASE_URL = "https://animepahe.pw";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface ApiPage<T> {
  current_page: number;
  last_page: number;
  data: T[];
}

export interface AnimeReference {
  id: string;
  session: string;
  title: string;
}

export async function getBaseUrl(
  providerContext: ProviderContext,
): Promise<string> {
  const preferred = await providerContext.kvStore.get<string>(
    "preferredDomain",
  );
  return (preferred || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

export function absoluteUrl(value: string, baseUrl: string): string {
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  return new URL(value, `${baseUrl}/`).href;
}

export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function makeAnimeLink(
  baseUrl: string,
  reference: AnimeReference,
): string {
  const url = new URL(`/a/${reference.id}`, baseUrl);
  url.searchParams.set("session", reference.session);
  url.searchParams.set("title", reference.title);
  return url.href;
}

export function parseAnimeLink(value: string, baseUrl: string): AnimeReference {
  const url = new URL(value, `${baseUrl}/`);
  const id = url.pathname.match(/\/a\/(\d+)/)?.[1] ||
    url.searchParams.get("anime_id") ||
    "";
  const session = url.searchParams.get("session") ||
    url.pathname.match(/\/anime\/([\w-]+)/)?.[1] ||
    "";
  return {
    id,
    session,
    title: url.searchParams.get("title") || "",
  };
}

function isChallenge(data: unknown): boolean {
  if (typeof data !== "string") return false;
  return /cf-chl-|just a moment|cloudflare ray id|ddos-guard/i.test(data);
}

function responseUrl(response: any, fallback: string): string {
  return (
    response?.request?.responseURL ||
    response?.request?.res?.responseUrl ||
    response?.config?.url ||
    fallback
  );
}

async function clearanceHeaders(
  providerContext: ProviderContext,
  namespace: string,
  referer: string,
): Promise<Record<string, string>> {
  const cookies = await providerContext.kvStore.get<string>(
    `${namespace}.cookies`,
  );
  const storedAgent = await providerContext.kvStore.get<string>(
    `${namespace}.userAgent`,
  );
  const configuredAgent = await providerContext.kvStore.get<string>(
    "cloudflareUserAgent",
  );
  return {
    ...providerContext.commonHeaders,
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    Referer: referer,
    "User-Agent": configuredAgent || storedAgent || DEFAULT_USER_AGENT,
    ...(cookies ? { Cookie: cookies } : {}),
  };
}

export interface PageResponse {
  data: unknown;
  finalUrl: string;
  userAgent: string;
}

export async function getWithClearance(
  providerContext: ProviderContext,
  url: string,
  options: {
    namespace: string;
    referer: string;
    title: string;
    description: string;
    signal?: AbortSignal;
    forceWebViewOnHtml?: boolean;
    challengeUrl?: string;
  },
): Promise<PageResponse> {
  const headers = await clearanceHeaders(
    providerContext,
    options.namespace,
    options.referer,
  );

  try {
    const response = await providerContext.axios.get(url, {
      signal: options.signal,
      headers,
    });
    if (!isChallenge(response.data) &&
        !(options.forceWebViewOnHtml && typeof response.data === "string")) {
      return {
        data: response.data,
        finalUrl: responseUrl(response, url),
        userAgent: headers["User-Agent"],
      };
    }
  } catch (error) {
    const status = (error as any)?.response?.status;
    if (![403, 429, 503].includes(Number(status))) throw error;
  }

  const challengeUrl = options.challengeUrl || url;
  const webViewHeaders = { ...headers };
  delete webViewHeaders.Cookie;
  delete webViewHeaders["sec-ch-ua"];
  delete webViewHeaders["sec-ch-ua-mobile"];
  delete webViewHeaders["sec-ch-ua-platform"];
  const solved = await providerContext.openWebView(challengeUrl, {
    title: options.title,
    description: options.description,
    headers: webViewHeaders,
    waitForCookie: "cf_clearance",
    force: true,
    timeoutMs: 120000,
  });
  if (solved.cookies) {
    await providerContext.kvStore.set(
      `${options.namespace}.cookies`,
      solved.cookies,
    );
  }
  if (solved.userAgent) {
    await providerContext.kvStore.set(
      `${options.namespace}.userAgent`,
      solved.userAgent,
    );
  }
  const retryHeaders = await clearanceHeaders(
    providerContext,
    options.namespace,
    options.referer,
  );
  let retry;
  try {
    retry = await providerContext.axios.get(url, {
      signal: options.signal,
      headers: retryHeaders,
    });
  } catch (error) {
    if ([403, 503].includes(Number((error as any)?.response?.status))) {
      throw new Error(
        "Cloudflare verification did not clear. Keep the verification page open until it closes automatically, then retry.",
      );
    }
    throw error;
  }
  if (isChallenge(retry.data)) {
    throw new Error("The Cloudflare check was still active after WebView verification");
  }
  return {
    data: retry.data,
    finalUrl: responseUrl(retry, url),
    userAgent: retryHeaders["User-Agent"],
  };
}

function normalizeApiPage<T>(data: unknown): ApiPage<T> {
  const value = typeof data === "string" ? JSON.parse(data) : data;
  if (!value || !Array.isArray((value as any).data)) {
    throw new Error("AnimePahe returned an invalid API response");
  }
  return {
    current_page: Number((value as any).current_page || 1),
    last_page: Number((value as any).last_page || 1),
    data: (value as any).data as T[],
  };
}

export async function getApiPage<T>(
  providerContext: ProviderContext,
  url: string,
  signal?: AbortSignal,
): Promise<ApiPage<T>> {
  const baseUrl = await getBaseUrl(providerContext);
  const response = await getWithClearance(providerContext, url, {
    namespace: "animepahe",
    referer: `${baseUrl}/`,
    title: "AnimePahe security check",
    description: "Complete the security check once, then return to Vega.",
    signal,
    challengeUrl: `${baseUrl}/`,
  });
  return normalizeApiPage<T>(response.data);
}

export async function getAnimePaheHtml(
  providerContext: ProviderContext,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const baseUrl = await getBaseUrl(providerContext);
  const response = await getWithClearance(providerContext, url, {
    namespace: "animepahe",
    referer: `${baseUrl}/`,
    title: "AnimePahe security check",
    description: "Complete the security check once, then return to Vega.",
    signal,
    challengeUrl: `${baseUrl}/`,
  });
  return String(response.data || "");
}

export async function cacheReference(
  providerContext: ProviderContext,
  reference: AnimeReference,
): Promise<void> {
  if (!reference.id || !reference.session) return;
  await providerContext.kvStore.set(
    `animepahe.session.${reference.id}`,
    reference.session,
  );
}

export async function findReference(
  providerContext: ProviderContext,
  id: string,
  title: string,
  signal?: AbortSignal,
): Promise<AnimeReference | undefined> {
  if (!title) return undefined;
  const baseUrl = await getBaseUrl(providerContext);
  const search = new URL("/api", baseUrl);
  search.searchParams.set("m", "search");
  search.searchParams.set("q", `${title} ${Math.floor(Date.now() / 1000)}`);
  search.searchParams.set("page", "1");
  const result = await getApiPage<{
    id: number;
    title: string;
    session: string;
  }>(providerContext, search.href, signal);
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const match = result.data.find((item) => String(item.id) === id) ||
    result.data.find(
      (item) =>
        item.title.toLowerCase().replace(/[^a-z0-9]+/g, "") ===
        normalizedTitle,
    );
  if (!match) return undefined;
  const reference = {
    id: String(match.id),
    session: match.session,
    title: match.title,
  };
  await cacheReference(providerContext, reference);
  return reference;
}
