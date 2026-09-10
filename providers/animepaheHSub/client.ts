import { OpenWebViewResult, ProviderContext } from "../types";

export const DEFAULT_BASE_URL = "https://animepahe.pw";

// Only used before the WebView has ever run. Once the user has passed the
// Cloudflare check, the User-Agent the WebView reported is the only one the
// cf_clearance cookie is valid for, so that value always wins.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Replaying the request a few times with a growing pause covers the delay
// between the interactive check finishing and Cloudflare accepting requests.
const RETRY_DELAYS = [800, 1800, 3000];
const CHALLENGE_ROUNDS = 1;
const RETRYABLE_STATUS = [403, 429, 503, 520, 521, 522, 523, 524];

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isChallenge(data: unknown): boolean {
  if (typeof data !== "string") return false;
  return (
    /just a moment|verify you are human|performing security verification|checking if the site connection is secure/i
      .test(data) ||
    /cf-chl-|cf_chl_opt|__cf_chl_|\/cdn-cgi\/challenge-platform\/|challenges\.cloudflare\.com/i
      .test(data) ||
    /enable javascript and cookies to continue|ddos-guard/i.test(data)
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// A WebView renders a JSON response inside a <pre> block, and Cloudflare can
// hand back JSON with an HTML content type. Both need unwrapping before parse.
export function extractJson(value: string): unknown {
  const candidates: string[] = [];
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(trimmed);
  }
  const pre = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i)?.[1];
  if (pre) candidates.push(decodeEntities(pre).trim());
  const body = trimmed.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  if (body) {
    candidates.push(decodeEntities(body.replace(/<[^>]+>/g, "")).trim());
  }
  const braced = trimmed.match(/\{[\s\S]*\}/)?.[0];
  if (braced) candidates.push(decodeEntities(braced));

  for (const candidate of candidates) {
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  return undefined;
}

function responseUrl(response: any, fallback: string): string {
  return (
    response?.request?.responseURL ||
    response?.request?.res?.responseUrl ||
    response?.config?.url ||
    fallback
  );
}

// Cloudflare appends its own __cf_chl_* parameters when it hands the browser
// back to the page, so the WebView's final URL is compared on the parts we
// actually asked for rather than byte for byte.
function sameTarget(candidate: string, target: string): boolean {
  let left;
  let right;
  try {
    left = new URL(candidate);
    right = new URL(target);
  } catch {
    return candidate.replace(/\/+$/, "") === target.replace(/\/+$/, "");
  }
  // The origin is deliberately not compared: animepahe.com and animepahe.org
  // both redirect to animepahe.pw, and the WebView reports where it landed.
  if (left.pathname.replace(/\/+$/, "") !== right.pathname.replace(/\/+$/, "")) {
    return false;
  }
  for (const [key, value] of right.searchParams) {
    if (left.searchParams.get(key) !== value) return false;
  }
  return true;
}

async function clearanceHeaders(
  providerContext: ProviderContext,
  namespace: string,
  referer: string,
  expect: "json" | "html",
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
    Accept: expect === "json"
      ? "application/json, text/plain, */*"
      : "text/html,application/xhtml+xml,*/*;q=0.8",
    Referer: referer,
    "User-Agent": storedAgent || configuredAgent || DEFAULT_USER_AGENT,
    ...(cookies ? { Cookie: cookies } : {}),
  };
}

export interface PageResponse {
  data: unknown;
  finalUrl: string;
  userAgent: string;
}

export interface ClearanceOptions {
  namespace: string;
  referer: string;
  title: string;
  description: string;
  signal?: AbortSignal;
  expect?: "json" | "html";
  forceWebViewOnHtml?: boolean;
  challengeUrl?: string;
}

async function tryRequest(
  providerContext: ProviderContext,
  url: string,
  options: ClearanceOptions,
): Promise<PageResponse | undefined> {
  const expect = options.expect || "html";
  const headers = await clearanceHeaders(
    providerContext,
    options.namespace,
    options.referer,
    expect,
  );
  let response;
  try {
    response = await providerContext.axios.get(url, {
      signal: options.signal,
      headers,
    });
  } catch (error) {
    const status = Number((error as any)?.response?.status);
    if (!RETRYABLE_STATUS.includes(status)) throw error;
    return undefined;
  }

  if (isChallenge(response.data)) return undefined;
  if (options.forceWebViewOnHtml && typeof response.data === "string") {
    return undefined;
  }

  let data: unknown = response.data;
  if (expect === "json" && typeof data === "string") {
    data = extractJson(data);
    if (data === undefined) return undefined;
  }
  return {
    data,
    finalUrl: responseUrl(response, url),
    userAgent: headers["User-Agent"],
  };
}

interface SolvedChallenge {
  data: string;
  url: string;
  hadClearance: boolean;
}

// Several scrapes can run at once (episode pagination, every resolution of a
// stream). They must share one dialog instead of stacking WebViews.
const inFlight: Record<string, Promise<SolvedChallenge> | undefined> = {};

async function openChallenge(
  providerContext: ProviderContext,
  challengeUrl: string,
  options: ClearanceOptions,
  round: number,
): Promise<SolvedChallenge> {
  // No header overrides here on purpose: a spoofed User-Agent makes Cloudflare
  // mint cf_clearance for a browser that does not match the WebView running the
  // challenge, and the cookie is then rejected on every later request.
  const solved: OpenWebViewResult = await providerContext.openWebView(
    challengeUrl,
    {
      title: `${options.title} — wait 10 seconds`,
      description: round === 0
        ? 'Tap "Verify you are human", wait at least 10 seconds for the requested AnimePahe page to finish loading, then tap Done.'
        : options.description,
      // Omitting waitForCookie is intentional. Vega otherwise closes the
      // dialog the instant Cloudflare creates the cookie, before its redirect
      // has loaded the API response that the provider needs.
      force: true,
      timeoutMs: 120000,
    },
  );
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
  return {
    data: String(solved.data || ""),
    url: solved.url || challengeUrl,
    hadClearance: Boolean(
      solved.cookieMap?.cf_clearance ||
        /(?:^|;\s*)cf_clearance=/.test(solved.cookies || ""),
    ),
  };
}

async function solveChallenge(
  providerContext: ProviderContext,
  challengeUrl: string,
  options: ClearanceOptions,
  round: number,
): Promise<SolvedChallenge> {
  const key = `${options.namespace}:${round}`;
  const pending = inFlight[key] ||
    openChallenge(providerContext, challengeUrl, options, round);
  inFlight[key] = pending;
  try {
    return await pending;
  } finally {
    if (inFlight[key] === pending) delete inFlight[key];
  }
}

// The WebView already rendered the page we wanted, so its DOM can be used
// straight away even when the cookie cannot be replayed over axios.
function webViewPayload(
  solved: SolvedChallenge,
  url: string,
  options: ClearanceOptions,
): PageResponse | undefined {
  if (!solved.data || isChallenge(solved.data)) return undefined;
  if (!sameTarget(solved.url, url)) return undefined;
  if ((options.expect || "html") === "json") {
    const parsed = extractJson(solved.data);
    if (parsed === undefined) return undefined;
    return { data: parsed, finalUrl: solved.url, userAgent: "" };
  }
  return { data: solved.data, finalUrl: solved.url, userAgent: "" };
}

async function withStoredUserAgent(
  providerContext: ProviderContext,
  namespace: string,
  response: PageResponse,
): Promise<PageResponse> {
  if (response.userAgent) return response;
  const stored = await providerContext.kvStore.get<string>(
    `${namespace}.userAgent`,
  );
  return { ...response, userAgent: stored || DEFAULT_USER_AGENT };
}

export async function getWithClearance(
  providerContext: ProviderContext,
  url: string,
  options: ClearanceOptions,
): Promise<PageResponse> {
  const direct = await tryRequest(providerContext, url, options);
  if (direct) return direct;

  if (typeof providerContext.openWebView !== "function") {
    throw new Error(
      "Cloudflare is protecting AnimePahe and this Vega build cannot open the verification page",
    );
  }

  let solvedAtLeastOnce = false;
  for (let round = 0; round < CHALLENGE_ROUNDS; round += 1) {
    // Solve on the request itself so the WebView's rendered response can be
    // used directly. Native HTTP can have a different TLS fingerprint, which
    // makes Cloudflare reject the same cookie outside the WebView.
    const challengeUrl = options.challengeUrl || url;
    let solved: SolvedChallenge;
    try {
      solved = await solveChallenge(
        providerContext,
        challengeUrl,
        options,
        round,
      );
    } catch (error) {
      // The dialog was cancelled or timed out; reopening it would only nag.
      throw new Error(
        `AnimePahe needs the Cloudflare verification page to finish: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    solvedAtLeastOnce = solvedAtLeastOnce || solved.hadClearance;

    const rendered = webViewPayload(solved, url, options);
    if (rendered) {
      return withStoredUserAgent(providerContext, options.namespace, rendered);
    }

    for (const delay of RETRY_DELAYS) {
      await wait(delay);
      const retry = await tryRequest(providerContext, url, options);
      if (retry) return retry;
    }
  }

  throw new Error(
    solvedAtLeastOnce
      ? "Cloudflare accepted the check but still blocked AnimePahe. Wait a few seconds and try again."
      : 'The Cloudflare check never completed. When the verification page opens, tap "Verify you are human" and leave it open until the AnimePahe page loads.',
  );
}

function normalizeApiPage<T>(data: unknown): ApiPage<T> {
  const value = typeof data === "string" ? extractJson(data) : data;
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
    description:
      "Complete the Cloudflare check, then wait for the AnimePahe page to load before returning to Vega.",
    signal,
    expect: "json",
  });
  return normalizeApiPage<T>(response.data);
}

export async function getAnimePaheHtml(
  providerContext: ProviderContext,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await getWithClearance(providerContext, url, {
    namespace: "animepahe",
    referer: `${await getBaseUrl(providerContext)}/`,
    title: "AnimePahe security check",
    description:
      "Complete the Cloudflare check, then wait for the AnimePahe page to load before returning to Vega.",
    signal,
    expect: "html",
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
