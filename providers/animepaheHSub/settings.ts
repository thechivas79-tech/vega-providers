import { ProviderContext, SettingsField } from "../types";

export async function getSettingsSchema({
  providerContext: _providerContext,
}: {
  providerContext: ProviderContext;
}): Promise<SettingsField[]> {
  return [
    {
      key: "preferredQuality",
      type: "select",
      label: "Preferred quality",
      options: [
        { label: "1080p", value: "1080" },
        { label: "720p", value: "720" },
        { label: "480p", value: "480" },
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
        { label: "480p", value: "480" },
        { label: "360p", value: "360" },
      ],
      defaultValue: ["1080", "720", "480", "360"],
    },
    {
      key: "apiBaseUrl",
      type: "text",
      label: "Native API mirror",
      description: "Optional JustAnime API mirror for advanced users.",
      placeholder: "https://core.justanime.to/api",
      defaultValue: "",
    },
  ];
}
