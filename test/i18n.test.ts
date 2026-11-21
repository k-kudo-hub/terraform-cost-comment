import { describe, expect, it } from "vitest";
import { renderComment } from "../src/comment.js";
import { estimatePlan, type TerraformPlan } from "../src/estimate.js";
import type { Pricer } from "../src/pricing.js";
import { estimateUsage } from "../src/resources.js";
import type { Msg } from "../src/types.js";

const JAPANESE = /[぀-ヿ一-龯]/;

/** Attributes that reach every text the estimators can produce. */
const SAMPLES: Array<
  [string, Record<string, unknown>, Record<string, unknown>?, Record<string, unknown>?]
> = [
  [
    "aws_instance",
    {
      instance_type: "t3.micro",
      associate_public_ip_address: true,
      root_block_device: [{ volume_size: 8, volume_type: "gp3" }],
    },
  ],
  [
    "aws_instance",
    { instance_type: "t3.micro", ebs_block_device: [{ volume_size: 8 }] },
    {
      root_block_device: true,
      associate_public_ip_address: true,
      ebs_block_device: [{ volume_type: true }],
    },
  ],
  ["aws_instance", {}, { instance_type: true }],
  ["aws_instance", { instance_type: "t3.micro", tenancy: "dedicated" }],
  ["aws_ebs_volume", { type: "gp3", size: 10, iops: 4000, throughput: 200 }],
  ["aws_ebs_volume", { type: "io1", size: 10, iops: 100 }],
  ["aws_ebs_volume", { type: "io2", size: 10, iops: 70000 }],
  ["aws_ebs_volume", { type: "io2", size: 10 }, { iops: true }],
  ["aws_ebs_volume", { type: "xyz", size: 10 }],
  ["aws_ebs_volume", { type: "gp3" }, { size: true }],
  [
    "aws_db_instance",
    {
      engine: "mysql",
      instance_class: "db.t3.micro",
      allocated_storage: 100,
      storage_type: "io1",
      iops: 1000,
    },
  ],
  [
    "aws_db_instance",
    {
      engine: "mysql",
      instance_class: "db.t3.micro",
      multi_az: true,
      allocated_storage: 500,
      storage_type: "gp3",
      iops: 15000,
    },
  ],
  [
    "aws_db_instance",
    { engine: "mysql", instance_class: "db.t3.micro", allocated_storage: 20 },
    { multi_az: true, storage_type: true },
    { configured: new Set(["engine"]) },
  ],
  [
    "aws_db_instance",
    { engine: "mysql", instance_class: "db.t3.micro", storage_type: "io1" },
    { allocated_storage: true, iops: true },
  ],
  [
    "aws_db_instance",
    {
      engine: "mysql",
      instance_class: "db.t3.micro",
      allocated_storage: 20,
      storage_type: "aurora",
    },
  ],
  ["aws_db_instance", { engine: "mysql", instance_class: "db.t3.micro" }, { multi_az: true }],
  ["aws_db_instance", { engine: "oracle-ee" }],
  ["aws_db_instance", {}, { engine: true }],
  ["aws_db_instance", { engine: "mysql" }, { instance_class: true }],
  ["aws_nat_gateway", {}],
  ["aws_lb", { load_balancer_type: "network" }],
  ["aws_lb", { load_balancer_type: "classic" }],
  ["aws_lb", {}, { load_balancer_type: true }],
  ["aws_eip", {}],
  ["aws_vpc_endpoint", { vpc_endpoint_type: "Interface", subnet_ids: ["a", "b"] }],
  ["aws_vpc_endpoint", { vpc_endpoint_type: "GatewayLoadBalancer", subnet_ids: ["a"] }],
  ["aws_vpc_endpoint", { vpc_endpoint_type: "Other" }],
  ["aws_vpc_endpoint", { vpc_endpoint_type: "Interface" }, { subnet_ids: true }],
  ["aws_vpc_endpoint", {}, { vpc_endpoint_type: true }],
  ["aws_elasticache_cluster", { engine: "redis", node_type: "cache.t3.micro", num_cache_nodes: 2 }],
  ["aws_elasticache_cluster", { replication_group_id: "rg" }],
  ["aws_elasticache_cluster", {}, { replication_group_id: true }],
  ["aws_elasticache_cluster", { engine: "foo", node_type: "cache.t3.micro" }],
  ["aws_elasticache_cluster", { engine: "redis" }, { node_type: true }],
  ["aws_elasticache_cluster", { engine: "redis", node_type: "x" }, { num_cache_nodes: true }],
  [
    "aws_elasticache_replication_group",
    { node_type: "cache.t3.micro" },
    { num_cache_clusters: true, num_node_groups: true },
  ],
  ["aws_elasticache_replication_group", {}, { engine: true }],
  ["aws_rds_cluster", { engine: "aurora-mysql" }],
  ["aws_rds_cluster", { engine: "mysql" }],
  ["aws_rds_cluster", { engine: "aurora-mysql", engine_mode: "serverless" }],
  ["aws_rds_cluster_instance", { engine: "aurora-mysql", instance_class: "db.r6g.large" }],
  [
    "aws_rds_cluster_instance",
    { engine: "aurora-mysql", instance_class: "db.r6g.large" },
    {},
    { auroraStorageType: "aurora-iopt1" },
  ],
  ["aws_rds_cluster_instance", { engine: "aurora-mysql", instance_class: "db.serverless" }],
  ["aws_eks_cluster", {}],
  [
    "aws_opensearch_domain",
    {
      cluster_config: [
        {
          instance_type: "r6g.large.search",
          instance_count: 2,
          dedicated_master_enabled: true,
          dedicated_master_type: "m6g.large.search",
          dedicated_master_count: 3,
          warm_enabled: true,
        },
      ],
      ebs_options: [{ ebs_enabled: true, volume_type: "io1", volume_size: 10, iops: 1000 }],
    },
  ],
  [
    "aws_opensearch_domain",
    {
      cluster_config: [{ instance_type: "r6g.large.search", dedicated_master_enabled: true }],
      ebs_options: [{ ebs_enabled: true, volume_type: "gp3", volume_size: 10, iops: 9000 }],
    },
  ],
  [
    "aws_opensearch_domain",
    {
      cluster_config: [{ instance_type: "r6g.large.search" }],
      ebs_options: [{ ebs_enabled: true, volume_type: "st1", volume_size: 10 }],
    },
  ],
  [
    "aws_opensearch_domain",
    { cluster_config: [{ instance_type: "r6g.large.search" }] },
    { ebs_options: true },
    { configured: new Set(["cluster_config"]) },
  ],
  [
    "aws_opensearch_domain",
    { cluster_config: [{ instance_type: "r6g.large.search" }] },
    { ebs_options: true, cluster_config: [{ dedicated_master_enabled: true }] },
  ],
  ["aws_opensearch_domain", {}],
  [
    "aws_opensearch_domain",
    { cluster_config: [{ instance_type: "r6g.large.search" }] },
    { cluster_config: [{ instance_count: true }] },
  ],
  ["aws_s3_bucket", {}],
];

describe("Japanese texts", () => {
  it("exist for every text the estimators produce", () => {
    const texts: Msg[] = [];
    for (const [type, attrs, unknown, context] of SAMPLES) {
      const r = estimateUsage(type, attrs, unknown ?? {}, "ap-northeast-1", context ?? {});
      texts.push(...r.lines.map((l) => l.description), ...r.partial, ...r.excluded);
      if (r.unestimable !== undefined) texts.push(r.unestimable);
    }
    const missing = texts.filter((t) => !JAPANESE.test(t.ja)).map((t) => t.en);
    expect(missing).toEqual([]);
  });

  it("make a ja comment free of the English reasons and usage descriptions", async () => {
    const pricer: Pricer = async (lines) => ({ prices: lines.map((line) => ({ line, cost: 10 })) });
    const plan: TerraformPlan = {
      resource_changes: [
        {
          address: "aws_nat_gateway.a",
          type: "aws_nat_gateway",
          mode: "managed",
          change: { actions: ["create"], after: {} },
        },
        {
          address: "aws_s3_bucket.b",
          type: "aws_s3_bucket",
          mode: "managed",
          change: { actions: ["create"], after: {} },
        },
        {
          address: "aws_instance.c",
          type: "aws_instance",
          mode: "managed",
          change: {
            actions: ["create"],
            after: { instance_type: "t3.micro" },
            after_unknown: { root_block_device: true },
          },
        },
      ],
    };
    const body = renderComment(await estimatePlan(plan, "ap-northeast-1", pricer), undefined, {
      region: "ap-northeast-1",
      rateType: "BEFORE_DISCOUNTS",
      tag: "",
      language: "ja",
    });
    for (const english of [
      "is not supported",
      "is not known",
      "NAT gateway (",
      "Linux on-demand",
      "data transfer",
      "data processing",
    ]) {
      expect(body).not.toContain(english);
    }
    expect(body).toContain("リソースの種類 aws_s3_bucket には対応していない");
    expect(body).toContain("ルートボリュームのサイズ（AMI で決まる）が apply まで分からない");
    expect(body).toContain("NAT ゲートウェイ（730 時間）");
  });
});
