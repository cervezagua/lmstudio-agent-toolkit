import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "rootDirectory",
    "string",
    {
      displayName: "Root Directory",
      subtitle: "Folder the documents live in. Files outside it cannot be read. Empty = this chat's working directory.",
      placeholder: "D:\\my-project",
    },
    "",
  )
  .field(
    "visionModel",
    "string",
    {
      displayName: "Vision Model",
      subtitle: "Model key used for OCR. Empty = the first loaded vision-capable model.",
      placeholder: "qwen/qwen3.8-27b",
    },
    "",
  )
  .field(
    "renderScale",
    "numeric",
    {
      min: 1,
      max: 4,
      step: 0.5,
      displayName: "PDF Render Scale",
      subtitle: "Higher renders pages larger, which reads small print better but costs more tokens and time.",
      slider: { min: 1, max: 4, step: 0.5 },
    },
    2,
  )
  .field(
    "maxPages",
    "numeric",
    {
      int: true,
      min: 1,
      max: 100,
      displayName: "Max Pages Per Call",
      subtitle: "Guards against sending a whole book to the model in one go.",
    },
    10,
  )
  .field(
    "maxOutputChars",
    "numeric",
    { int: true, min: 1000, max: 200000, displayName: "Max Output Characters" },
    20000,
  )
  .build();
