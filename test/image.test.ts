import { describe, expect, it } from "vitest";
import { imageTag } from "../src/image.js";

describe("imageTag", () => {
  // 期望值用 shell 獨立算：printf 'FROM node:22\n\0%s' '22.16.0' | sha256sum | cut -c1-12
  it("tags the image with the hash of the Dockerfile and the target repo's .nvmrc", () => {
    expect(imageTag("sandcastle-teamsync", "FROM node:22\n", "22.16.0")).toBe("sandcastle-teamsync:7bcf7a68c4a5");
  });

  it("ignores a trailing newline in .nvmrc", () => {
    expect(imageTag("sandcastle-teamsync", "FROM node:22\n", "22.16.0\n")).toBe("sandcastle-teamsync:7bcf7a68c4a5");
  });

  it("changes when the Node version changes", () => {
    expect(imageTag("sandcastle-teamsync", "FROM node:22\n", "24.1.0")).not.toBe("sandcastle-teamsync:7bcf7a68c4a5");
  });
});
