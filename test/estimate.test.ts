import { describe, expect, it } from "vitest";
import { detectRegion, estimatePlan, type TerraformPlan } from "../src/estimate.js";
import type { Pricer } from "../src/pricing.js";

/** Fake pricer: an instance hour costs 0.01, anything else 1 per unit, "bad" usage types fail. */
const pricer: Pricer = async (lines) => ({
  prices: lines.map((line) =>
    line.usageType.includes("bad")
      ? { line, error: "BAD_REQUEST: No matching usage" }
      : { line, cost: line.usageType.includes("BoxUsage") ? line.amount * 0.01 : line.amount },
  ),
});

const change = (
  address: string,
  type: string,
  actions: string[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  after_unknown: Record<string, unknown> = {},
) => ({ address, type, mode: "managed", change: { actions, before, after, after_unknown } });

const plan = (...resource_changes: ReturnType<typeof change>[]): TerraformPlan => ({
  resource_changes,
});

describe("estimatePlan", () => {
  it("adds the cost of created resources", async () => {
    const r = await estimatePlan(
      plan(
        change("aws_instance.web", "aws_instance", ["create"], null, { instance_type: "t3.micro" }),
      ),
      "us-east-1",
      pricer,
    );
    expect(r.totalDelta).toBeCloseTo(7.3);
    expect(r.resources[0]).toMatchObject({
      address: "aws_instance.web",
      action: "create",
      before: 0,
    });
    expect(r.resources[0]?.after).toBeCloseTo(7.3);
  });

  it("subtracts the cost of deleted resources", async () => {
    const r = await estimatePlan(
      plan(
        change(
          "aws_ebs_volume.data",
          "aws_ebs_volume",
          ["delete"],
          { type: "gp3", size: 50 },
          null,
        ),
      ),
      "us-east-1",
      pricer,
    );
    expect(r.totalDelta).toBe(-50);
    expect(r.resources[0]).toMatchObject({ action: "delete", before: 50, after: 0, delta: -50 });
  });

  it("takes the difference for updates and replacements", async () => {
    const r = await estimatePlan(
      plan(
        change(
          "aws_ebs_volume.a",
          "aws_ebs_volume",
          ["update"],
          { type: "gp3", size: 50 },
          { type: "gp3", size: 80 },
        ),
        change(
          "aws_instance.b",
          "aws_instance",
          ["delete", "create"],
          { instance_type: "t3.micro" },
          { instance_type: "t3.large" },
        ),
      ),
      "us-east-1",
      pricer,
    );
    expect(r.resources.map((x) => [x.address, x.action, x.delta])).toEqual([
      ["aws_ebs_volume.a", "update", 30],
      ["aws_instance.b", "replace", 0],
    ]);
  });

  it("orders resources by the size of the increase, largest first", async () => {
    const r = await estimatePlan(
      plan(
        change("aws_ebs_volume.small", "aws_ebs_volume", ["create"], null, {
          type: "gp3",
          size: 10,
        }),
        change(
          "aws_ebs_volume.gone",
          "aws_ebs_volume",
          ["delete"],
          { type: "gp3", size: 20 },
          null,
        ),
        change("aws_ebs_volume.big", "aws_ebs_volume", ["create"], null, {
          type: "gp3",
          size: 500,
        }),
      ),
      "us-east-1",
      pricer,
    );
    expect(r.resources.map((x) => x.address)).toEqual([
      "aws_ebs_volume.big",
      "aws_ebs_volume.small",
      "aws_ebs_volume.gone",
    ]);
  });

  it("ignores no-op, read and data resources", async () => {
    const r = await estimatePlan(
      plan(
        change(
          "aws_instance.same",
          "aws_instance",
          ["no-op"],
          { instance_type: "t3.micro" },
          { instance_type: "t3.micro" },
        ),
        { ...change("data.aws_ami.x", "aws_ami", ["read"], null, {}), mode: "data" },
      ),
      "us-east-1",
      pricer,
    );
    expect(r.resources).toEqual([]);
    expect(r.notEstimated).toEqual([]);
  });

  it("lists changed resources it cannot estimate instead of hiding them", async () => {
    const r = await estimatePlan(
      plan(
        change("aws_s3_bucket.logs", "aws_s3_bucket", ["create"], null, {}),
        change("aws_instance.x", "aws_instance", ["create"], null, {}, { instance_type: true }),
      ),
      "us-east-1",
      pricer,
    );
    expect(r.resources).toEqual([]);
    expect(r.notEstimated.map((n) => [n.address, n.reason])).toEqual([
      ["aws_s3_bucket.logs", "resource type aws_s3_bucket is not supported"],
      ["aws_instance.x", "instance type is not known until apply"],
    ]);
  });

  it("treats a resource as not estimated when the API cannot price one of its lines", async () => {
    const r = await estimatePlan(
      plan(
        change("aws_instance.odd", "aws_instance", ["create"], null, { instance_type: "bad.type" }),
      ),
      "us-east-1",
      pricer,
    );
    expect(r.resources).toEqual([]);
    expect(r.notEstimated[0]?.reason).toContain("BAD_REQUEST");
    expect(r.totalDelta).toBe(0);
  });

  it("keeps the parts left out of an estimated resource", async () => {
    const r = await estimatePlan(
      plan(change("aws_nat_gateway.main", "aws_nat_gateway", ["create"], null, {})),
      "us-east-1",
      pricer,
    );
    expect(r.resources[0]?.excluded).toContain("NAT gateway data processing (per GB)");
  });
});

describe("detectRegion", () => {
  it("reads a constant region from the aws provider configuration", () => {
    const p: TerraformPlan = {
      configuration: {
        provider_config: {
          aws: { name: "aws", expressions: { region: { constant_value: "ap-northeast-1" } } },
        },
      },
    };
    expect(detectRegion(p)).toBe("ap-northeast-1");
  });

  it("follows a region given through a variable", () => {
    const p: TerraformPlan = {
      variables: { region: { value: "eu-west-1" } },
      configuration: {
        provider_config: {
          aws: { name: "aws", expressions: { region: { references: ["var.region"] } } },
        },
      },
    };
    expect(detectRegion(p)).toBe("eu-west-1");
  });

  it("returns undefined when the region cannot be read", () => {
    expect(detectRegion({})).toBeUndefined();
  });
});
