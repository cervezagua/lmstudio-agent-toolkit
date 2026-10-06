import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "maxChars",
    "numeric",
    {
      int: true,
      min: 1000,
      max: 200000,
      displayName: "Max Characters",
      subtitle: "Longer pages are returned in parts; the model asks for the next part with offset.",
    },
    15000,
  )
  .build();
