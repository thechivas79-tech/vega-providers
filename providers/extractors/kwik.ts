// Kwik hosts the video for AnimePahe and for part of Anikai's back catalogue.
// Its player page ships two Dean Edwards packed blocks - a cookie helper and
// the one holding the HLS source - so every block has to be tried.

const PACKER_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

const PACKED_BLOCK = /eval\(function\(p,a,c,k,e,(?:d|r)\)/g;

const PACKED_PATTERNS = [
  /eval\(function\(p,a,c,k,e,(?:d|r)\)[\s\S]*?\}\(\s*'((?:\\.|[^'\\])*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:\\.|[^'\\])*)'\.split\(\s*'\|'\s*\)/,
  /eval\(function\(p,a,c,k,e,(?:d|r)\)[\s\S]*?\}\(\s*"((?:\\.|[^"\\])*)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*"((?:\\.|[^"\\])*)"\.split\(\s*"\|"\s*\)/,
];

function encodePackerNumber(value: number, radix: number): string {
  if (value === 0) return "0";
  let current = value;
  let output = "";
  while (current > 0) {
    output = PACKER_ALPHABET[current % radix] + output;
    current = Math.floor(current / radix);
  }
  return output;
}

function unescapeJavascriptString(value: string): string {
  return value.replace(
    /\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|n|r|t|b|f|v|0|\\|'|")/g,
    (_, token: string) => {
      if (token.startsWith("u")) {
        return String.fromCharCode(parseInt(token.slice(1), 16));
      }
      if (token.startsWith("x")) {
        return String.fromCharCode(parseInt(token.slice(1), 16));
      }
      const escaped: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
        "\\": "\\",
        "'": "'",
        '"': '"',
      };
      return escaped[token] ?? token;
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function unpackDeanEdwards(source: string): string {
  const match = PACKED_PATTERNS.map((pattern) => pattern.exec(source)).find(
    Boolean,
  );
  if (!match) throw new Error("Kwik's packed script was missing");
  const payload = unescapeJavascriptString(match[1]);
  const radix = Number(match[2]);
  const count = Number(match[3]);
  const dictionary = unescapeJavascriptString(match[4]).split("|");
  if (radix < 2 || radix > PACKER_ALPHABET.length) {
    throw new Error(`Kwik used unsupported packer radix ${radix}`);
  }

  let unpacked = payload;
  for (let index = count - 1; index >= 0; index -= 1) {
    const replacement = dictionary[index];
    if (!replacement) continue;
    const token = encodePackerNumber(index, radix);
    unpacked = unpacked.replace(
      new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"),
      replacement,
    );
  }
  return unpacked;
}

// Every packed block on the page, unpacked, in document order.
export function unpackAll(html: string): string[] {
  const offsets: number[] = [];
  const finder = new RegExp(PACKED_BLOCK.source, "g");
  let found = finder.exec(html);
  while (found) {
    offsets.push(found.index);
    found = finder.exec(html);
  }
  if (!offsets.length) throw new Error("Kwik's packed script was missing");

  const unpacked: string[] = [];
  for (const offset of offsets) {
    try {
      unpacked.push(unpackDeanEdwards(html.slice(offset)));
    } catch {
      // A block that will not unpack is simply not the one we want.
    }
  }
  if (!unpacked.length) throw new Error("Kwik's packed script could not be read");
  return unpacked;
}

function firstStreamUrl(unpacked: string): string {
  const explicit = unpacked.match(
    /const\s+source\s*=\s*\\?['"](https?:\\?\/\\?\/[^'"\s]+?\.m3u8[^'"]*)/i,
  )?.[1];
  const fallback = unpacked.match(
    /https?:\\?\/\\?\/[^'"\\\s]+\.m3u8[^'"\\\s]*/i,
  )?.[0];
  return (explicit || fallback || "")
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&");
}

export function extractKwikSource(html: string): string {
  for (const unpacked of unpackAll(html)) {
    const stream = firstStreamUrl(unpacked);
    if (stream) return stream;
  }
  throw new Error("Kwik HLS source was missing after unpacking");
}

// Kwik titles its player page after the file, e.g.
// "AnimePahe_Liar_Game_-_07_720p_SubsPlease.mp4".
export function kwikQuality(html: string): string {
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || "";
  return title.match(/(\d{3,4})\s*p\b/i)?.[1] || "";
}

export function kwikTitle(html: string): string {
  return (html.match(/<title>([^<]*)<\/title>/i)?.[1] || "")
    .replace(/\s+/g, " ")
    .trim();
}
