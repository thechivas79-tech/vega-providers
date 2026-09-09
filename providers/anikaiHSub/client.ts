import { ProviderContext } from "../types";

export const DEFAULT_BASE_URL = "https://anikai.tv";

export async function getBaseUrl(
  providerContext: ProviderContext,
): Promise<string> {
  const override = await providerContext.kvStore.get<string>("baseUrlOverride");
  return (override || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

export function absoluteUrl(value: string, baseUrl: string): string {
  if (!value) return "";
  if (value.startsWith("//")) return `https:${value}`;
  return new URL(value, `${baseUrl}/`).href;
}

export async function getHtml(
  providerContext: ProviderContext,
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await providerContext.axios.get(url, {
    signal,
    headers: {
      ...providerContext.commonHeaders,
      Accept: "text/html,application/xhtml+xml",
      Referer: `${new URL(url).origin}/`,
    },
  });
  return String(response.data || "");
}

export function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function seriesTitleFromEpisode(value: string): string {
  return cleanText(value)
    .replace(/\s+Episode\s+\d+(?:\.\d+)?(?:\s+English\s+Subbed)?\s*$/i, "")
    .replace(/\s+English\s+Subbed\s*$/i, "");
}
