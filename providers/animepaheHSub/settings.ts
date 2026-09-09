import { ProviderContext, SettingsField } from "../types";

export async function getSettingsSchema({
  providerContext: _providerContext,
}: {
  providerContext: ProviderContext;
}): Promise<SettingsField[]> {
  return [
    {
      key: "preferredDomain",
      type: "select",
      label: "AnimePahe domain",
      description: "Choose an available official AnimePahe mirror.",
      options: [
        { label: "animepahe.pw", value: "https://animepahe.pw" },
        { label: "animepahe.com", value: "https://animepahe.com" },
        { label: "animepahe.org", value: "https://animepahe.org" },
      ],
      defaultValue: "https://animepahe.pw",
    },
    {
      key: "preferredQuality",
      type: "select",
      label: "Preferred quality",
      options: [
        { label: "1080p", value: "1080" },
        { label: "720p", value: "720" },
        { label: "360p", value: "360" },
      ],
      defaultValue: "1080",
    },
    {
      key: "allowedResolutions",
      type: "multiselect",
      label: "Allowed resolutions",
      options: [
        { label: "1080p", value: "1080" },
        { label: "720p", value: "720" },
        { label: "360p", value: "360" },
      ],
      defaultValue: ["1080", "720", "360"],
    },
    {
      key: "cloudflareUserAgent",
      type: "text",
      label: "Cloudflare User-Agent",
      description: "Optional browser User-Agent used for AnimePahe and Kwik checks.",
      placeholder: "Leave empty to use Vega's default",
      defaultValue: "",
    },
  ];
}
