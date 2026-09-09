import { ProviderContext, SettingsField } from "../types";

export async function getSettingsSchema({
  providerContext: _providerContext,
}: {
  providerContext: ProviderContext;
}): Promise<SettingsField[]> {
  return [
    {
      key: "baseUrlOverride",
      type: "text",
      label: "Custom Anikai domain",
      description: "Use a full mirror URL if anikai.tv changes domain.",
      placeholder: "https://anikai.tv",
      defaultValue: "",
    },
  ];
}
