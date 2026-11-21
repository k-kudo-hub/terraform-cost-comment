import { describe, expect, it } from "vitest";
import { usageTypePrefix } from "../src/regions.js";

describe("usageTypePrefix", () => {
  it("returns the billing prefix of a region", () => {
    expect(usageTypePrefix("ap-northeast-1")).toBe("APN1-");
    expect(usageTypePrefix("eu-west-1")).toBe("EU-");
    expect(usageTypePrefix("us-east-1")).toBe("");
  });

  it("rejects regions the Pricing Calculator API does not support", () => {
    expect(() => usageTypePrefix("us-gov-west-1")).toThrow(/not supported/);
    expect(() => usageTypePrefix("cn-north-1")).toThrow(/not supported/);
  });
});
