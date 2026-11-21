import { describe, expect, it } from "vitest";
import { estimateUsage, isSupportedType } from "../src/resources.js";

const TOKYO = "ap-northeast-1";
const VIRGINIA = "us-east-1";

const usage = (
  type: string,
  after: Record<string, unknown>,
  region = TOKYO,
  unknown: Record<string, unknown> = {},
  context = {},
) => estimateUsage(type, after, unknown, region, context);

const rows = (r: ReturnType<typeof usage>) =>
  r.lines.map((l) => [l.serviceCode, l.usageType, l.operation, l.amount]);

describe("types added for ElastiCache, Aurora, EKS, OpenSearch, public IPv4 and VPC endpoints", () => {
  it("are supported", () => {
    for (const t of [
      "aws_elasticache_cluster",
      "aws_elasticache_replication_group",
      "aws_rds_cluster",
      "aws_rds_cluster_instance",
      "aws_eks_cluster",
      "aws_opensearch_domain",
      "aws_elasticsearch_domain",
      "aws_eip",
      "aws_vpc_endpoint",
    ]) {
      expect(isSupportedType(t)).toBe(true);
    }
  });
});

describe("aws_elasticache_cluster", () => {
  it("prices every node of a Redis cluster", () => {
    const r = usage("aws_elasticache_cluster", {
      engine: "redis",
      node_type: "cache.t3.micro",
      num_cache_nodes: 1,
    });
    expect(rows(r)).toEqual([
      ["AmazonElastiCache", "APN1-NodeUsage:cache.t3.micro", "CreateCacheCluster:0002", 730],
    ]);
  });

  it("knows Memcached and Valkey", () => {
    const m = usage("aws_elasticache_cluster", {
      engine: "memcached",
      node_type: "cache.m5.large",
      num_cache_nodes: 3,
    });
    expect(rows(m)).toEqual([
      ["AmazonElastiCache", "APN1-NodeUsage:cache.m5.large", "CreateCacheCluster:0001", 2190],
    ]);
    const v = usage("aws_elasticache_cluster", {
      engine: "valkey",
      node_type: "cache.t3.micro",
      num_cache_nodes: 1,
    });
    expect(v.lines[0]?.operation).toBe("CreateCacheCluster:Valkey");
  });

  it("lists a read replica added to a replication group as not estimated", () => {
    const r = usage("aws_elasticache_cluster", { replication_group_id: "rg-1" });
    expect(r.unestimable).toContain("read replica added to replication group rg-1");
  });

  it("cannot estimate when replication group membership is not known until apply", () => {
    const r = usage(
      "aws_elasticache_cluster",
      { engine: "redis", node_type: "cache.t3.micro", num_cache_nodes: 1 },
      TOKYO,
      { replication_group_id: true },
    );
    expect(r.unestimable).toContain("membership");
  });

  it("cannot estimate a node type that is not known until apply", () => {
    const r = usage("aws_elasticache_cluster", { engine: "redis" }, TOKYO, { node_type: true });
    expect(r.unestimable).toBeDefined();
  });
});

describe("aws_elasticache_replication_group", () => {
  it("prices num_cache_clusters nodes, Redis by default", () => {
    const r = usage("aws_elasticache_replication_group", {
      node_type: "cache.r6g.large",
      num_cache_clusters: 2,
    });
    expect(rows(r)).toEqual([
      ["AmazonElastiCache", "APN1-NodeUsage:cache.r6g.large", "CreateCacheCluster:0002", 1460],
    ]);
  });

  it("prices shards times (replicas + 1) in cluster mode", () => {
    const r = usage("aws_elasticache_replication_group", {
      engine: "valkey",
      node_type: "cache.r6g.large",
      num_node_groups: 3,
      replicas_per_node_group: 1,
    });
    expect(r.lines[0]?.amount).toBe(730 * 6);
  });

  it("cannot estimate when the number of nodes is not known until apply", () => {
    const r = usage("aws_elasticache_replication_group", { node_type: "cache.r6g.large" }, TOKYO, {
      num_cache_clusters: true,
    });
    expect(r.unestimable).toBeDefined();
  });
});

describe("aws_rds_cluster_instance", () => {
  it("prices an Aurora MySQL instance at the Aurora Standard rate", () => {
    const r = usage(
      "aws_rds_cluster_instance",
      { engine: "aurora-mysql", instance_class: "db.r6g.large" },
      TOKYO,
      {},
      { auroraStorageType: "aurora" },
    );
    expect(rows(r)).toEqual([
      ["AmazonRDS", "APN1-InstanceUsage:db.r6g.large", "CreateDBInstance:0016", 730],
    ]);
    expect(r.partial).toEqual([]);
  });

  it("prices an instance of an I/O-Optimized cluster at its own rate", () => {
    const r = usage(
      "aws_rds_cluster_instance",
      { engine: "aurora-postgresql", instance_class: "db.r6g.large" },
      TOKYO,
      {},
      { auroraStorageType: "aurora-iopt1" },
    );
    expect(rows(r)).toEqual([
      ["AmazonRDS", "APN1-InstanceUsageIOOptimized:db.r6g.large", "CreateDBInstance:0021", 730],
    ]);
  });

  it("reports when the cluster's storage type cannot be read", () => {
    const r = usage("aws_rds_cluster_instance", {
      engine: "aurora-mysql",
      instance_class: "db.r6g.large",
    });
    expect(r.lines).toHaveLength(1);
    expect(r.partial[0]).toContain("I/O-Optimized");
  });

  it("cannot estimate Aurora Serverless v2, which is billed by capacity used", () => {
    const r = usage("aws_rds_cluster_instance", {
      engine: "aurora-postgresql",
      instance_class: "db.serverless",
    });
    expect(r.unestimable).toContain("Serverless");
  });
});

describe("aws_rds_cluster", () => {
  it("has no fixed monthly charge of its own and names storage and I/O as usage based", () => {
    const r = usage("aws_rds_cluster", { engine: "aurora-mysql" });
    expect(r.lines).toEqual([]);
    expect(r.unestimable).toBeUndefined();
    expect(r.excluded.join(" ")).toContain("Aurora storage");
  });

  it("cannot estimate Aurora Serverless v1", () => {
    const r = usage("aws_rds_cluster", { engine: "aurora-mysql", engine_mode: "serverless" });
    expect(r.unestimable).toBeDefined();
  });
});

describe("aws_eks_cluster", () => {
  it("prices cluster hours, with the USE1- prefix in us-east-1", () => {
    expect(rows(usage("aws_eks_cluster", {}, VIRGINIA))).toEqual([
      ["AmazonEKS", "USE1-AmazonEKS-Hours:perCluster", "CreateOperation", 730],
    ]);
    expect(usage("aws_eks_cluster", {}).lines[0]?.usageType).toBe(
      "APN1-AmazonEKS-Hours:perCluster",
    );
  });

  it("names the extended support surcharge", () => {
    expect(usage("aws_eks_cluster", {}).excluded.join(" ")).toContain("extended support");
  });
});

describe("aws_opensearch_domain", () => {
  it("prices data nodes, dedicated master nodes and EBS storage per data node", () => {
    const r = usage("aws_opensearch_domain", {
      cluster_config: [
        {
          instance_type: "r6g.large.search",
          instance_count: 3,
          dedicated_master_enabled: true,
          dedicated_master_type: "m6g.large.search",
          dedicated_master_count: 3,
        },
      ],
      ebs_options: [{ ebs_enabled: true, volume_type: "gp3", volume_size: 100 }],
    });
    expect(rows(r)).toEqual([
      ["AmazonES", "APN1-ESInstance:r6g.large", "ESDomain", 2190],
      ["AmazonES", "APN1-ESInstance:m6g.large", "ESDomain", 2190],
      ["AmazonES", "APN1-ES:GP3-Storage", "ESDomain", 300],
    ]);
  });

  it("prices io1 storage and IOPS", () => {
    const r = usage("aws_opensearch_domain", {
      cluster_config: [{ instance_type: "r6g.large.search", instance_count: 2 }],
      ebs_options: [{ ebs_enabled: true, volume_type: "io1", volume_size: 50, iops: 1000 }],
    });
    expect(rows(r).slice(1)).toEqual([
      ["AmazonES", "APN1-ES:PIOPS-Storage", "ESDomain", 100],
      ["AmazonES", "APN1-ES:PIOPS", "ESDomain", 2000],
    ]);
  });

  it("reports gp3 performance above the baseline and UltraWarm nodes as not estimated", () => {
    const r = usage("aws_opensearch_domain", {
      cluster_config: [
        {
          instance_type: "r6g.large.search",
          instance_count: 1,
          warm_enabled: true,
          warm_type: "ultrawarm1.medium.search",
          warm_count: 2,
        },
      ],
      ebs_options: [{ ebs_enabled: true, volume_type: "gp3", volume_size: 20, iops: 6000 }],
    });
    expect(r.partial).toEqual([
      "UltraWarm nodes are not supported",
      "gp3 IOPS and throughput above the baseline are not supported",
    ]);
  });

  it("treats aws_elasticsearch_domain the same way", () => {
    const r = usage("aws_elasticsearch_domain", {
      cluster_config: [{ instance_type: "t3.small.elasticsearch", instance_count: 1 }],
      ebs_options: [{ ebs_enabled: true, volume_type: "gp2", volume_size: 10 }],
    });
    expect(rows(r)).toEqual([
      ["AmazonES", "APN1-ESInstance:t3.small", "ESDomain", 730],
      ["AmazonES", "APN1-ES:GP2-Storage", "ESDomain", 10],
    ]);
  });

  it("cannot estimate an instance type that is not known until apply", () => {
    const r = usage("aws_opensearch_domain", { cluster_config: [{}] }, TOKYO, {
      cluster_config: [{ instance_type: true }],
    });
    expect(r.unestimable).toBeDefined();
  });
});

describe("aws_eip", () => {
  it("prices the public IPv4 address, with the USE1- prefix in us-east-1", () => {
    expect(rows(usage("aws_eip", { domain: "vpc" }, VIRGINIA))).toEqual([
      ["AmazonVPC", "USE1-PublicIPv4:InUseAddress", "", 730],
    ]);
  });
});

describe("aws_instance public IPv4", () => {
  it("adds the public IPv4 address when one is requested", () => {
    const r = usage("aws_instance", {
      instance_type: "t3.micro",
      associate_public_ip_address: true,
    });
    expect(r.lines.map((l) => l.usageType)).toContain("APN1-PublicIPv4:InUseAddress");
  });
});

describe("aws_vpc_endpoint", () => {
  it("prices an interface endpoint per subnet", () => {
    const r = usage("aws_vpc_endpoint", {
      vpc_endpoint_type: "Interface",
      subnet_ids: ["subnet-a", "subnet-b", "subnet-c"],
    });
    expect(rows(r)).toEqual([["AmazonVPC", "APN1-VpcEndpoint-Hours", "VpcEndpoint", 2190]]);
  });

  it("counts subnets whose ids are known only after apply", () => {
    const r = usage(
      "aws_vpc_endpoint",
      { vpc_endpoint_type: "Interface", subnet_ids: [null, null] },
      TOKYO,
      { subnet_ids: [true, true] },
    );
    expect(r.lines[0]?.amount).toBe(1460);
  });

  it("cannot estimate when the number of subnets is not known until apply", () => {
    const r = usage("aws_vpc_endpoint", { vpc_endpoint_type: "Interface" }, TOKYO, {
      subnet_ids: true,
    });
    expect(r.unestimable).toBeDefined();
  });

  it("prices a Gateway Load Balancer endpoint", () => {
    const r = usage("aws_vpc_endpoint", {
      vpc_endpoint_type: "GatewayLoadBalancer",
      subnet_ids: ["subnet-a"],
    });
    expect(rows(r)).toEqual([["AmazonVPC", "APN1-VpcEndpoint-GWLBE-Hours", "VpcEndpoint", 730]]);
  });

  it("knows gateway endpoints have no hourly charge", () => {
    const r = usage("aws_vpc_endpoint", { vpc_endpoint_type: "Gateway" });
    expect(r.lines).toEqual([]);
    expect(r.unestimable).toBeUndefined();
  });
});

describe("aws_db_instance provisioned IOPS storage", () => {
  const db = (over: Record<string, unknown>) =>
    usage("aws_db_instance", {
      engine: "mysql",
      instance_class: "db.m5.large",
      allocated_storage: 100,
      iops: 1000,
      ...over,
    });

  it("prices io1 storage and IOPS", () => {
    expect(rows(db({ storage_type: "io1" })).slice(1)).toEqual([
      ["AmazonRDS", "APN1-RDS:PIOPS-Storage", "CreateDBInstance:0002", 100],
      ["AmazonRDS", "APN1-RDS:PIOPS", "CreateDBInstance:0002", 1000],
    ]);
  });

  it("prices io2 storage and IOPS in Multi-AZ", () => {
    expect(rows(db({ storage_type: "io2", multi_az: true })).slice(1)).toEqual([
      ["AmazonRDS", "APN1-RDS:Multi-AZ-PIOPS-Storage-IO2", "CreateDBInstance:0002", 100],
      ["AmazonRDS", "APN1-RDS:Multi-AZ-IO2-PIOPS", "CreateDBInstance:0002", 1000],
    ]);
  });

  it("reports IOPS that are not known until apply", () => {
    const r = usage(
      "aws_db_instance",
      {
        engine: "mysql",
        instance_class: "db.m5.large",
        allocated_storage: 100,
        storage_type: "io1",
      },
      TOKYO,
      { iops: true },
    );
    expect(r.lines).toHaveLength(2);
    expect(r.partial).toEqual(["provisioned IOPS is not known until apply"]);
  });
});

describe("attributes left out of the configuration take their defaults", () => {
  const configured = (...keys: string[]) => ({ configured: new Set(keys) });

  it("prices an RDS instance without multi_az as Single-AZ and says so", () => {
    const r = usage(
      "aws_db_instance",
      { engine: "postgres", instance_class: "db.t3.micro", allocated_storage: 20 },
      TOKYO,
      { multi_az: true, storage_type: true, iops: true },
      configured("engine", "instance_class", "allocated_storage"),
    );
    expect(rows(r)).toEqual([
      ["AmazonRDS", "APN1-InstanceUsage:db.t3.micro", "CreateDBInstance:0014", 730],
      ["AmazonRDS", "APN1-RDS:GP3-Storage", "CreateDBInstance:0014", 20],
    ]);
    expect(r.lines[0]?.description).toContain("multi_az not set");
    expect(r.partial).toEqual([]);
  });

  it("still cannot estimate multi_az set from a value known only after apply", () => {
    const r = usage(
      "aws_db_instance",
      { engine: "postgres", instance_class: "db.t3.micro", allocated_storage: 20 },
      TOKYO,
      { multi_az: true },
      configured("engine", "instance_class", "allocated_storage", "multi_az"),
    );
    expect(r.unestimable).toBeDefined();
  });

  it("uses io1 as the RDS default storage when iops is set", () => {
    const r = usage(
      "aws_db_instance",
      { engine: "mysql", instance_class: "db.m5.large", allocated_storage: 100, iops: 1000 },
      TOKYO,
      { storage_type: true, multi_az: true },
      configured("engine", "instance_class", "allocated_storage", "iops"),
    );
    expect(r.lines.map((l) => l.usageType)).toEqual([
      "APN1-InstanceUsage:db.m5.large",
      "APN1-RDS:PIOPS-Storage",
      "APN1-RDS:PIOPS",
    ]);
  });

  it("uses gp2 for an EBS volume without type", () => {
    const r = usage(
      "aws_ebs_volume",
      { size: 10 },
      TOKYO,
      { type: true, iops: true, throughput: true },
      configured("availability_zone", "size"),
    );
    expect(r.lines[0]?.usageType).toBe("APN1-EBS:VolumeUsage.gp2");
  });

  it("prices a standalone ElastiCache cluster whose replication_group_id is not set", () => {
    const r = usage(
      "aws_elasticache_cluster",
      { engine: "memcached", node_type: "cache.t3.micro", num_cache_nodes: 1 },
      TOKYO,
      { replication_group_id: true },
      configured("cluster_id", "engine", "node_type", "num_cache_nodes"),
    );
    expect(r.lines).toHaveLength(1);
  });

  it("prices a minimal replication group as one Redis node", () => {
    const r = usage(
      "aws_elasticache_replication_group",
      { node_type: "cache.t3.micro" },
      TOKYO,
      {
        engine: true,
        num_cache_clusters: true,
        num_node_groups: true,
        replicas_per_node_group: true,
      },
      configured("replication_group_id", "description", "node_type"),
    );
    expect(rows(r)).toEqual([
      ["AmazonElastiCache", "APN1-NodeUsage:cache.t3.micro", "CreateCacheCluster:0002", 730],
    ]);
  });
});

describe("fixes from the review of the added resources", () => {
  const configured = (...keys: string[]) => ({ configured: new Set(keys) });

  it("lists a Multi-AZ DB cluster as not estimated instead of dropping it", () => {
    const r = usage("aws_rds_cluster", {
      engine: "mysql",
      db_cluster_instance_class: "db.m6gd.large",
      allocated_storage: 100,
      storage_type: "io1",
      iops: 1000,
    });
    expect(r.unestimable).toBe("Multi-AZ DB clusters are not supported");
  });

  it("does not assume gp3 when iops is written but known only after apply", () => {
    const r = usage(
      "aws_db_instance",
      { engine: "mysql", instance_class: "db.m5.large", allocated_storage: 100 },
      TOKYO,
      { storage_type: true, iops: true, multi_az: true },
      configured("engine", "instance_class", "allocated_storage", "iops"),
    );
    expect(r.partial).toEqual(["storage type is not known until apply"]);
  });

  it("reports OpenSearch EBS storage and master nodes that are known only after apply", () => {
    const r = usage(
      "aws_opensearch_domain",
      {
        cluster_config: [{ instance_type: "r6g.large.search", instance_count: 1 }],
        ebs_options: [{}],
      },
      TOKYO,
      {
        cluster_config: [{ dedicated_master_enabled: true }],
        ebs_options: [{ ebs_enabled: true }],
      },
    );
    expect(r.partial).toEqual([
      "dedicated master nodes are not known until apply",
      "EBS storage is not known until apply",
    ]);
  });

  it("names EBS storage that may be written as a dynamic block it cannot read", () => {
    const r = usage(
      "aws_opensearch_domain",
      { cluster_config: [{ instance_type: "r6g.large.search", instance_count: 1 }] },
      TOKYO,
      { ebs_options: true },
      configured("domain_name", "cluster_config"),
    );
    expect(r.partial).toEqual([]);
    expect(r.excluded).toContain("OpenSearch EBS storage written as a dynamic ebs_options block");
  });

  it("cannot estimate an OpenSearch domain without an instance type", () => {
    expect(usage("aws_opensearch_domain", {}).unestimable).toBeDefined();
  });

  it("names the public IPv4 address an instance may get from its subnet", () => {
    const r = usage("aws_instance", { instance_type: "t3.micro" }, TOKYO, {
      associate_public_ip_address: true,
    });
    expect(r.excluded).toContain("EC2 public IPv4 address when the subnet assigns one");
  });

  it("counts one shard when only replicas_per_node_group is set", () => {
    const r = usage(
      "aws_elasticache_replication_group",
      { node_type: "cache.r6g.large", replicas_per_node_group: 2 },
      TOKYO,
      { engine: true, num_cache_clusters: true, num_node_groups: true },
      configured("replication_group_id", "description", "node_type", "replicas_per_node_group"),
    );
    expect(r.lines[0]?.amount).toBe(730 * 3);
  });
});
