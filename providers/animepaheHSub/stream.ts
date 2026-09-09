import { ProviderContext, Stream } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  extractKwikSource,
  unpackDeanEdwards,
} from "../extractors/kwik";
import {
  getAnimePaheHtml,
  getBaseUrl,
  getWithClearance,
} from "./client";

export { extractKwikSource, unpackDeanEdwards };

async function resolveKwik(
  url: string,
  baseUrl: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
): Promise<{ url: string; referer: string; userAgent: string }> {
  let response = await getWithClearance(providerContext, url, {
    namespace: "kwik",
    referer: `${baseUrl}/`,
    title: "Kwik security check",
    description: "Complete the video host security check, then return to Vega.",
    signal,
  });
  let html = String(response.data || "");
  if (!/eval\(function\(p,a,c,k,e,/i.test(html)) {
    response = await getWithClearance(providerContext, response.finalUrl || url, {
      namespace: "kwik",
      referer: `${baseUrl}/`,
      title: "Kwik video check",
      description: "Open the player once so Vega can resolve its H-Sub stream.",
      signal,
      forceWebViewOnHtml: true,
    });
    html = String(response.data || "");
  }
  return {
    url: extractKwikSource(html),
    referer: response.finalUrl || url,
    userAgent: response.userAgent,
  };
}

function originOf(url: string, fallback: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
}

// Once a challenge has defeated us there is no point dragging the user through
// the same dialog again for every remaining resolution.
function isClearanceFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /cloudflare|verification|security check/i.test(message);
}

function qualityOf(label: string): string {
  return label.match(/(360|480|720|1080|2160)\s*p?/i)?.[1] || "";
}

export async function getStream({
  link,
  signal,
  providerContext,
}: {
  link: string;
  type: string;
  signal?: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}): Promise<Stream[]> {
  try {
    const baseUrl = await getBaseUrl(providerContext);
    const playUrl = new URL(link, `${baseUrl}/`);
    playUrl.searchParams.delete("anime_id");
    const html = await getAnimePaheHtml(
      providerContext,
      playUrl.href,
      signal,
    );
    const $ = providerContext.cheerio.load(html);
    const preferred =
      (await providerContext.kvStore.get<string>("preferredQuality")) ||
      "1080";
    const allowed =
      (await providerContext.kvStore.get<string[]>("allowedResolutions")) ||
      ["1080", "720", "360"];
    const candidates = $("div#resolutionMenu > button[data-src]")
      .map((_: number, node: any) => ({
        url: $(node).attr("data-src") || "",
        label: $(node).text().replace(/\s+/g, " ").trim(),
      }))
      .get()
      .filter((item: { url: string; label: string }) => {
        const quality = qualityOf(item.label);
        return item.url && (!quality || allowed.includes(quality));
      });

    // Resolve the wanted quality first: if Kwik throws up a security check, it
    // is spent on the stream the user actually asked for.
    candidates.sort(
      (left: { label: string }, right: { label: string }) => {
        const leftQuality = qualityOf(left.label);
        const rightQuality = qualityOf(right.label);
        return (
          (rightQuality === preferred ? 1 : 0) -
            (leftQuality === preferred ? 1 : 0) ||
          Number(rightQuality || 0) - Number(leftQuality || 0)
        );
      },
    );

    const streams: Stream[] = [];
    let clearanceError: unknown;
    for (const candidate of candidates) {
      try {
        const resolved = await resolveKwik(
          candidate.url,
          baseUrl,
          providerContext,
          signal,
        );
        const quality = qualityOf(candidate.label);
        streams.push({
          server: candidate.label || `Kwik ${quality || "HLS"}`,
          link: resolved.url,
          type: "m3u8",
          quality: quality || undefined,
          tag: "H-Sub",
          tags: ["H-Sub", "English Subbed"],
          headers: {
            Origin: originOf(resolved.referer, "https://kwik.si"),
            Referer: resolved.referer,
            "User-Agent": resolved.userAgent,
          },
        });
      } catch (error) {
        console.log("AnimePahe Kwik source failed", error);
        if (isClearanceFailure(error)) {
          clearanceError = error;
          break;
        }
      }
    }
    const unique = streams.filter(
      (stream, index, all) =>
        all.findIndex((candidate) => candidate.link === stream.link) === index,
    );
    unique.sort((left, right) => {
      const leftPreferred = left.quality === preferred ? 1 : 0;
      const rightPreferred = right.quality === preferred ? 1 : 0;
      return (
        rightPreferred - leftPreferred ||
        Number(right.quality || 0) - Number(left.quality || 0)
      );
    });
    if (!unique.length) {
      if (clearanceError) throw clearanceError;
      throw new Error("No playable AnimePahe H-Sub streams were found");
    }
    return unique;
  } catch (error) {
    throwProviderError("AnimePahe H-Sub", "stream", error);
  }
}
