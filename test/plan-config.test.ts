import { describe, expect, it } from "vitest";
import { splitAddress } from "../src/plan-config.js";

describe("splitAddress", () => {
  it("separates module path, resource address and instance key", () => {
    expect(splitAddress("aws_rds_cluster.main")).toEqual({
      modules: [],
      local: "aws_rds_cluster.main",
    });
    expect(splitAddress('module.db.module.inner[0].aws_rds_cluster.this["a.b"]')).toEqual({
      modules: ["db", "inner"],
      local: "aws_rds_cluster.this",
    });
  });
});
