import { describe, expect, it } from "vitest";
import { detectRegion, estimatePlan, type TerraformPlan } from "../src/estimate.js";
import type { Pricer } from "../src/pricing.js";

/** Fake hourly prices by instance type; anything else costs 1 per unit; "bad" usage types fail. */
const HOURLY: Record<string, number> = { "t3.micro": 0.01, "t3.large": 0.08 };
const pricer: Pricer = async (lines) => ({
  prices: lines.map((line) => {
    if (line.usageType.includes("bad")) return { line, error: "BAD_REQUEST: No matching usage" };
    const type = line.usageType.split("BoxUsage:")[1];
    return { line, cost: type === undefined ? line.amount : line.amount * (HOURLY[type] ?? 0) };
  }),
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
      ["aws_instance.b", "replace", 51.1],
      ["aws_ebs_volume.a", "update", 30],
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

  it("keeps unpriced parts from both sides of an update", async () => {
    const r = await estimatePlan(
      plan(
        change(
          "aws_db_instance.db",
          "aws_db_instance",
          ["update"],
          {
            engine: "mysql",
            instance_class: "db.t3.micro",
            allocated_storage: 500,
            storage_type: "gp3",
            iops: 15000,
          },
          {
            engine: "mysql",
            instance_class: "db.t3.micro",
            allocated_storage: 100,
            storage_type: "gp3",
          },
        ),
      ),
      "us-east-1",
      pricer,
    );
    expect(r.resources[0]?.partial).toEqual([
      "before the change: gp3 IOPS and throughput above the baseline are not supported",
    ]);
  });

  it("counts resources of other providers without listing them as not estimated", async () => {
    const r = await estimatePlan(
      plan(
        change("random_id.suffix", "random_id", ["create"], null, {}),
        change("null_resource.x", "null_resource", ["create"], null, {}),
      ),
      "us-east-1",
      pricer,
    );
    expect(r.notEstimated).toEqual([]);
    expect(r.otherProviderCount).toBe(2);
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

describe("Aurora cluster storage type", () => {
  const instance = (after: Record<string, unknown>, unknown: Record<string, unknown> = {}) =>
    change(
      "aws_rds_cluster_instance.writer",
      "aws_rds_cluster_instance",
      ["create"],
      null,
      { engine: "aurora-mysql", instance_class: "db.r6g.large", ...after },
      unknown,
    );
  const cluster = (
    address: string,
    after: Record<string, unknown>,
    unknown: Record<string, unknown> = {},
  ) =>
    change(
      address,
      "aws_rds_cluster",
      ["create"],
      null,
      { engine: "aurora-mysql", ...after },
      unknown,
    );
  const usageTypeOf = async (p: TerraformPlan) =>
    (await estimatePlan(p, "us-east-1", pricer)).resources.find(
      (r) => r.type === "aws_rds_cluster_instance",
    );

  it("matches the cluster by its identifier", async () => {
    const r = await usageTypeOf(
      plan(
        cluster("aws_rds_cluster.main", {
          cluster_identifier: "main",
          storage_type: "aurora-iopt1",
        }),
        instance({ cluster_identifier: "main" }),
      ),
    );
    expect(r?.lines[0]?.usageType).toBe("InstanceUsageIOOptimized:db.r6g.large");
    expect(r?.partial).toEqual([]);
  });

  it("follows the reference in the configuration when the identifier is known only after apply", async () => {
    const p: TerraformPlan = {
      ...plan(
        cluster(
          "aws_rds_cluster.main",
          { storage_type: "aurora-iopt1" },
          { cluster_identifier: true },
        ),
        instance({}, { cluster_identifier: true }),
      ),
      configuration: {
        root_module: {
          resources: [
            {
              address: "aws_rds_cluster.main",
              expressions: { storage_type: { constant_value: "aurora-iopt1" } },
            },
            {
              address: "aws_rds_cluster_instance.writer",
              expressions: {
                cluster_identifier: {
                  references: ["aws_rds_cluster.main.id", "aws_rds_cluster.main"],
                },
              },
            },
          ],
        },
      },
    };
    expect((await usageTypeOf(p))?.lines[0]?.usageType).toBe(
      "InstanceUsageIOOptimized:db.r6g.large",
    );
  });

  it("follows references inside modules", async () => {
    const p: TerraformPlan = {
      resource_changes: [
        {
          ...cluster(
            "module.db.aws_rds_cluster.this[0]",
            {},
            { cluster_identifier: true, storage_type: true },
          ),
        },
        {
          ...instance({}, { cluster_identifier: true }),
          address: "module.db.aws_rds_cluster_instance.writer",
        },
      ],
      configuration: {
        root_module: {
          module_calls: {
            db: {
              module: {
                resources: [
                  { address: "aws_rds_cluster.this", expressions: {} },
                  {
                    address: "aws_rds_cluster_instance.writer",
                    expressions: {
                      cluster_identifier: {
                        references: ["aws_rds_cluster.this[0].id", "aws_rds_cluster.this"],
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const r = await usageTypeOf(p);
    // storage_type is not set in the configuration, so the cluster is Aurora Standard.
    expect(r?.lines[0]?.usageType).toBe("InstanceUsage:db.r6g.large");
    expect(r?.partial).toEqual([]);
  });

  it("reports the instance when its cluster cannot be found", async () => {
    const r = await usageTypeOf(plan(instance({ cluster_identifier: "elsewhere" })));
    expect(r?.lines[0]?.usageType).toBe("InstanceUsage:db.r6g.large");
    expect(r?.partial[0]).toContain("I/O-Optimized");
  });
});
