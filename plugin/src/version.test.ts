import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { TOOLKIT_VERSION } from "./version";

describe("TOOLKIT_VERSION", () => {
  // web_doctor compares this with the latest release, so a release must not bump one and forget the other.
  it("equals the version in plugin/package.json", () => {
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
    expect(TOOLKIT_VERSION).toBe(manifest.version);
    expect(TOOLKIT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
