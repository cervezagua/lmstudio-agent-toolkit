import { describe, expect, it } from "vitest";
import { configSchematics, makeConfigSchematics } from "../config";
import { AUTO_MODEL, configuredModelKey, listModelChoices, toModelChoices } from "./models";

describe("configuredModelKey", () => {
  it("treats empty and auto alike, as 'pick one automatically'", () => {
    expect(configuredModelKey("")).toBe("");
    expect(configuredModelKey("  ")).toBe("");
    expect(configuredModelKey(AUTO_MODEL)).toBe("");
    expect(configuredModelKey(" auto ")).toBe("");
    expect(configuredModelKey(" publisher/model-name ")).toBe("publisher/model-name");
  });
});

describe("toModelChoices", () => {
  const models = [
    { modelKey: "b/vision", displayName: "Vision B", vision: true, trainedForToolUse: false },
    { modelKey: "a/tools", displayName: "Tools A", vision: false, trainedForToolUse: true },
    { modelKey: "c/both", displayName: "Both C", vision: true, trainedForToolUse: true },
    { modelKey: "d/plain", displayName: "Plain D", vision: false, trainedForToolUse: false },
  ];

  // The flags are not always set, and the text field these replace accepted any key, so no model is
  // left out; the flags only put the likely fits first and label them.
  it("offers every model in both dropdowns, likely fits first and labelled", () => {
    const choices = toModelChoices(models);
    expect(choices.vision).toEqual([
      { value: "c/both", displayName: "Both C · vision" },
      { value: "b/vision", displayName: "Vision B · vision" },
      { value: "d/plain", displayName: "Plain D" },
      { value: "a/tools", displayName: "Tools A" },
    ]);
    expect(choices.subagent.map(o => o.value)).toEqual(["c/both", "a/tools", "d/plain", "b/vision"]);
  });

  it("still offers a model whose flags were never set", () => {
    const choices = toModelChoices([{ modelKey: "remote/unflagged" }]);
    expect(choices.vision.map(o => o.value)).toEqual(["remote/unflagged"]);
    expect(choices.subagent.map(o => o.value)).toEqual(["remote/unflagged"]);
  });

  // A dropdown refuses duplicate values, and would fail to build.
  it("lists each model key once, and tells apart models that share a display name", () => {
    const choices = toModelChoices([
      { modelKey: "x/model", displayName: "Model" },
      { modelKey: "x/model", displayName: "Model (Q8)" },
      { modelKey: "y/model", displayName: "Model" },
    ]);
    expect(choices.vision).toEqual([
      { value: "x/model", displayName: "Model (x/model)" },
      { value: "y/model", displayName: "Model (y/model)" },
    ]);
  });

  it("never lists a model whose key collides with the Auto choice, or has no key", () => {
    const choices = toModelChoices([
      { modelKey: AUTO_MODEL, vision: true },
      { modelKey: "", vision: true },
    ]);
    expect(choices.vision).toEqual([]);
  });
});

describe("listModelChoices", () => {
  const env = { LMS_PLUGIN_CLIENT_IDENTIFIER: "id", LMS_PLUGIN_CLIENT_PASSKEY: "key" };
  const never = () => new Promise<never>(() => {});
  const fakeClient = (overrides: { downloaded?: () => Promise<unknown>; loaded?: () => Promise<unknown>; dispose?: () => Promise<void> }) =>
    (() =>
      ({
        system: { listDownloadedModels: overrides.downloaded ?? (async () => []) },
        llm: { listLoaded: overrides.loaded ?? (async () => []) },
        [Symbol.asyncDispose]: overrides.dispose ?? (async () => {}),
      }) as any) as any;

  it("returns nothing without LM Studio's plugin credentials, so the settings stay text fields", async () => {
    expect(await listModelChoices({})).toBeNull();
  });

  it("offers loaded models too, so one that is not a local download can be chosen", async () => {
    const choices = await listModelChoices(
      env,
      1000,
      fakeClient({
        downloaded: async () => [{ modelKey: "local/model", displayName: "Local" }],
        loaded: async () => [{ modelKey: "linked/model", displayName: "Linked", vision: true }],
      }),
    );
    expect(choices!.vision.map(o => o.value)).toEqual(["linked/model", "local/model"]);
  });

  // Disposing waits for calls still in flight, so awaiting it after a timeout could hold up the
  // plugin's startup forever. The listing must give up on time even when disposal never finishes.
  it("gives up on time even when the server never answers and disposal never finishes", async () => {
    const started = Date.now();
    const choices = await listModelChoices(env, 50, fakeClient({ downloaded: never, loaded: never, dispose: never }));
    expect(choices).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still lists downloaded models when listing the loaded ones fails", async () => {
    const choices = await listModelChoices(
      env,
      1000,
      fakeClient({
        downloaded: async () => [{ modelKey: "local/model" }],
        loaded: async () => Promise.reject(new Error("not allowed")),
      }),
    );
    expect(choices!.subagent.map(o => o.value)).toEqual(["local/model"]);
  });
});

describe("model settings", () => {
  const choices = {
    vision: [{ value: "m/vision", displayName: "Vision" }],
    subagent: [{ value: "m/tools", displayName: "Tools" }],
  };

  it("are dropdowns with an Auto choice first when the models could be listed", () => {
    const schema = makeConfigSchematics(choices);
    for (const key of ["visionModel", "subagentModel"] as const) {
      expect(schema.getValueType(key)).toBe("select");
      expect((schema.getValueTypeParam(key) as any).options[0].value).toBe(AUTO_MODEL);
    }
  });

  it("stay text fields otherwise", () => {
    expect(configSchematics.getValueType("visionModel")).toBe("string");
    expect(configSchematics.getValueType("subagentModel")).toBe("string");
  });

  it("still build when no model qualifies", () => {
    expect(() => makeConfigSchematics({ vision: [], subagent: [] })).not.toThrow();
  });

  // The panel validates against the dropdown and rejects a model that is no longer downloaded. The
  // tools read with the text version, so a stale value reaches them as a key they can report on,
  // never as a failure to read the settings.
  it("are read by the tools as text, so a model deleted since it was chosen still reads", () => {
    expect(makeConfigSchematics(choices).getSchemaForKey("visionModel").safeParse("deleted/model").success).toBe(false);
    expect(configSchematics.getSchemaForKey("visionModel").safeParse("deleted/model").success).toBe(true);
  });
});
