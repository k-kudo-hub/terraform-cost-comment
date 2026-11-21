import { type PrefixStyle, usageTypePrefix } from "./regions.js";
import type { Attributes, UsageLine, UsageResult } from "./types.js";

/** Hours in a month, the figure AWS Pricing Calculator uses. */
export const HOURS_PER_MONTH = 730;

/** Facts from elsewhere in the plan that one resource's price depends on. */
export interface UsageContext {
  /**
   * storage_type of the Aurora cluster an aws_rds_cluster_instance belongs to:
   * "aurora" (Standard), "aurora-iopt1" (I/O-Optimized), or undefined when it cannot be read.
   */
  auroraStorageType?: string;
  /**
   * Top-level attributes written in the resource's configuration block. An attribute the plan
   * marks "known after apply" but the configuration leaves out takes its default.
   * Undefined when the plan has no configuration for the resource.
   */
  configured?: ReadonlySet<string>;
}

interface Env {
  region: string;
  context: UsageContext;
  /** Usage type prefix of the region in the billing style of a service. */
  px(style?: PrefixStyle): string;
}

type Estimator = (attrs: Attributes, unknown: Attributes, prefix: string, env: Env) => UsageResult;

const isUnknown = (unknown: Attributes, key: string): boolean => unknown[key] === true;

const str = (attrs: Attributes, key: string): string | undefined => {
  const v = attrs[key];
  return typeof v === "string" && v !== "" ? v : undefined;
};

const num = (attrs: Attributes, key: string): number | undefined => {
  const v = attrs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

const blocks = (attrs: Attributes, key: string): Attributes[] => {
  const v = attrs[key];
  return Array.isArray(v)
    ? v.filter((b): b is Attributes => typeof b === "object" && b !== null)
    : [];
};

const blockUnknown = (unknown: Attributes, key: string, index: number): Attributes => {
  const v = unknown[key];
  if (Array.isArray(v) && typeof v[index] === "object" && v[index] !== null) {
    return v[index] as Attributes;
  }
  return {};
};

const unestimable = (reason: string): UsageResult => ({
  lines: [],
  excluded: [],
  partial: [],
  unestimable: reason,
});

// ---------------------------------------------------------------- EBS

interface EbsVolumeType {
  storage: string;
  operation: string;
}

/** Verified against the Price List API and GetUsageLinesEstimatedCost (2026-11-21). */
const EBS_TYPES: Readonly<Record<string, EbsVolumeType>> = {
  gp2: { storage: "EBS:VolumeUsage.gp2", operation: "CreateVolume-Gp2" },
  gp3: { storage: "EBS:VolumeUsage.gp3", operation: "CreateVolume-Gp3" },
  io1: { storage: "EBS:VolumeUsage.piops", operation: "CreateVolume-P-IOPS" },
  io2: { storage: "EBS:VolumeUsage.io2", operation: "CreateVolume-io2" },
  st1: { storage: "EBS:VolumeUsage.st1", operation: "CreateVolume-St1" },
  sc1: { storage: "EBS:VolumeUsage.sc1", operation: "CreateVolume-Sc1" },
  standard: { storage: "EBS:VolumeUsage", operation: "CreateVolume" },
};

const GP3_FREE_IOPS = 3000;
const GP3_FREE_THROUGHPUT_MIBPS = 125;
/** io2 IOPS price tiers: up to 32,000, 32,001-64,000, above 64,000. */
const IO2_TIERS: ReadonlyArray<{ suffix: string; size: number }> = [
  { suffix: "", size: 32000 },
  { suffix: ".tier2", size: 32000 },
  { suffix: ".tier3", size: Number.POSITIVE_INFINITY },
];

/** One EBS volume's attributes; `undefined` = not set, "unknown" = known only after apply. */
interface EbsSpec {
  label: string;
  type: string | undefined | "unknown";
  size: number | undefined | "unknown";
  iops: number | undefined | "unknown";
  throughput: number | undefined | "unknown";
}

/**
 * Usage lines of one EBS volume. `partial` lists priced parts that could not be estimated;
 * `unestimable` is set when even the storage could not be priced.
 */
function ebsLines(
  spec: EbsSpec,
  prefix: string,
): { lines: UsageLine[]; partial: string[]; unestimable?: string } {
  const { label, type, size, iops, throughput } = spec;
  if (size === undefined || size === "unknown") {
    return { lines: [], partial: [], unestimable: `${label} size is not known until apply` };
  }
  if (type === undefined || type === "unknown") {
    return { lines: [], partial: [], unestimable: `${label} type is not known until apply` };
  }
  const t = EBS_TYPES[type];
  if (t === undefined) {
    return { lines: [], partial: [], unestimable: `${label} type "${type}" is not supported` };
  }
  const line = (usageType: string, amount: number, description: string): UsageLine => ({
    serviceCode: "AmazonEC2",
    usageType: prefix + usageType,
    operation: t.operation,
    amount,
    description,
  });
  const lines = [line(t.storage, size, `${label} ${type} ${size} GB`)];
  const partial: string[] = [];
  // gp3 IOPS and throughput left unset are computed at the free baseline, so only io1/io2
  // (where IOPS are always charged) need a value to be priced.
  if ((type === "io1" || type === "io2") && iops === "unknown") {
    partial.push(`${label} IOPS is not known until apply`);
  }
  const knownIops = typeof iops === "number" ? iops : undefined;
  const knownThroughput = typeof throughput === "number" ? throughput : undefined;
  if (type === "gp3") {
    if (knownIops !== undefined && knownIops > GP3_FREE_IOPS) {
      lines.push(
        line("EBS:VolumeP-IOPS.gp3", knownIops - GP3_FREE_IOPS, `${label} IOPS above 3,000`),
      );
    }
    if (knownThroughput !== undefined && knownThroughput > GP3_FREE_THROUGHPUT_MIBPS) {
      lines.push(
        line(
          "EBS:VolumeP-Throughput.gp3",
          (knownThroughput - GP3_FREE_THROUGHPUT_MIBPS) / 1024,
          `${label} throughput above 125 MiB/s`,
        ),
      );
    }
  } else if (type === "io1" && knownIops !== undefined && knownIops > 0) {
    lines.push(line("EBS:VolumeP-IOPS.piops", knownIops, `${label} ${knownIops} provisioned IOPS`));
  } else if (type === "io2" && knownIops !== undefined && knownIops > 0) {
    let rest = knownIops;
    for (const tier of IO2_TIERS) {
      if (rest <= 0) break;
      const amount = Math.min(rest, tier.size);
      lines.push(
        line(
          `EBS:VolumeP-IOPS.io2${tier.suffix}`,
          amount,
          `${label} provisioned IOPS${tier.suffix}`,
        ),
      );
      rest -= amount;
    }
  }
  return { lines, partial };
}

/** Reads an attribute as a value, "unknown" (known after apply) or undefined (not set). */
function read<T>(
  get: (a: Attributes, k: string) => T | undefined,
  attrs: Attributes,
  unknown: Attributes,
  key: string,
): T | undefined | "unknown" {
  return isUnknown(unknown, key) ? "unknown" : get(attrs, key);
}

/** True when the attribute is left out of the configuration, so its default applies. */
const notConfigured = (env: Env, key: string): boolean =>
  env.context.configured !== undefined && !env.context.configured.has(key);

/**
 * Like `read`, but an attribute that is "known after apply" only because the configuration
 * leaves it out reads as undefined (not set), so the caller applies its default.
 */
function readSet<T>(
  get: (a: Attributes, k: string) => T | undefined,
  attrs: Attributes,
  unknown: Attributes,
  key: string,
  env: Env,
): T | undefined | "unknown" {
  const v = read(get, attrs, unknown, key);
  return v === "unknown" && notConfigured(env, key) ? undefined : v;
}

const ebsVolume: Estimator = (attrs, unknown, prefix, env) => {
  // Default per the EC2 CreateVolume API reference: gp2.
  const type = readSet(str, attrs, unknown, "type", env);
  const result = ebsLines(
    {
      label: "volume",
      type: type ?? "gp2",
      size: read(num, attrs, unknown, "size"),
      iops: read(num, attrs, unknown, "iops"),
      throughput: read(num, attrs, unknown, "throughput"),
    },
    prefix,
  );
  if (result.unestimable !== undefined) return unestimable(result.unestimable);
  return { lines: result.lines, partial: result.partial, excluded: ["EBS snapshots"] };
};

// ---------------------------------------------------------------- EC2

const instance: Estimator = (attrs, unknown, prefix, env) => {
  const type = str(attrs, "instance_type");
  if (type === undefined || isUnknown(unknown, "instance_type")) {
    return unestimable("instance type is not known until apply");
  }
  const tenancy = str(attrs, "tenancy");
  if (tenancy !== undefined && tenancy !== "default") {
    return unestimable(`tenancy "${tenancy}" is not supported`);
  }
  const lines: UsageLine[] = [
    {
      serviceCode: "AmazonEC2",
      usageType: `${prefix}BoxUsage:${type}`,
      operation: "RunInstances",
      amount: HOURS_PER_MONTH,
      description: `${type} Linux on-demand (${HOURS_PER_MONTH} h)`,
    },
  ];
  const partial: string[] = [];
  const volumes: Array<[string, string]> = [
    ["root_block_device", "root volume"],
    ["ebs_block_device", "EBS volume"],
  ];
  for (const [key, label] of volumes) {
    if (isUnknown(unknown, key)) {
      // A root volume always exists; left unconfigured, its size comes from the AMI.
      // ebs_block_device is wholly unknown when none is configured, so there is nothing to price.
      if (key === "root_block_device")
        partial.push("root volume size (from the AMI) is not known until apply");
      continue;
    }
    blocks(attrs, key).forEach((block, i) => {
      const u = blockUnknown(unknown, key, i);
      const result = ebsLines(
        {
          label,
          type: read(str, block, u, "volume_type"),
          size: read(num, block, u, "volume_size"),
          iops: read(num, block, u, "iops"),
          throughput: read(num, block, u, "throughput"),
        },
        prefix,
      );
      lines.push(...result.lines);
      partial.push(...result.partial);
      if (result.unestimable !== undefined) partial.push(result.unestimable);
    });
  }
  // Only an explicit request: left unset, the subnet decides and the plan cannot tell.
  const excluded = ["EC2 operating system licenses other than Linux", "data transfer"];
  if (attrs.associate_public_ip_address === true) {
    lines.push(publicIpv4(env, "public IPv4 address"));
  } else if (isUnknown(unknown, "associate_public_ip_address")) {
    excluded.push("EC2 public IPv4 address when the subnet assigns one");
  }
  return { lines, partial, excluded };
};

// ---------------------------------------------------------------- RDS

/** Engine -> operation code, verified against the Price List API (2026-11-21). */
const RDS_ENGINES: Readonly<Record<string, string>> = {
  mysql: "CreateDBInstance:0002",
  postgres: "CreateDBInstance:0014",
  mariadb: "CreateDBInstance:0018",
};

interface RdsStorage {
  single: string;
  multi: string;
  /** Provisioned IOPS usage types, for io1 and io2. */
  iops?: { single: string; multi: string };
}

/** Verified against the Price List API and GetUsageLinesEstimatedCost (2026-11-21). */
const RDS_STORAGE: Readonly<Record<string, RdsStorage>> = {
  gp2: { single: "RDS:GP2-Storage", multi: "RDS:Multi-AZ-GP2-Storage" },
  gp3: { single: "RDS:GP3-Storage", multi: "RDS:Multi-AZ-GP3-Storage" },
  standard: { single: "RDS:StorageUsage", multi: "RDS:Multi-AZ-StorageUsage" },
  io1: {
    single: "RDS:PIOPS-Storage",
    multi: "RDS:Multi-AZ-PIOPS-Storage",
    iops: { single: "RDS:PIOPS", multi: "RDS:Multi-AZ-PIOPS" },
  },
  io2: {
    single: "RDS:PIOPS-Storage-IO2",
    multi: "RDS:Multi-AZ-PIOPS-Storage-IO2",
    iops: { single: "RDS:IO2-PIOPS", multi: "RDS:Multi-AZ-IO2-PIOPS" },
  },
};

const dbInstance: Estimator = (attrs, unknown, prefix, env) => {
  const engine = str(attrs, "engine");
  if (engine === undefined || isUnknown(unknown, "engine")) {
    return unestimable("engine is not known until apply");
  }
  const operation = RDS_ENGINES[engine];
  if (operation === undefined) return unestimable(`engine "${engine}" is not supported`);
  const cls = str(attrs, "instance_class");
  if (cls === undefined || isUnknown(unknown, "instance_class")) {
    return unestimable("instance class is not known until apply");
  }
  const multiAzValue = readSet((a, k) => a[k], attrs, unknown, "multi_az", env);
  if (multiAzValue === "unknown") return unestimable("Multi-AZ is not known until apply");
  const multiAz = multiAzValue === true;
  // The RDS API reference states no default for MultiAZ; say so when we assume Single-AZ.
  const azNote = multiAzValue === undefined ? " Single-AZ (multi_az not set)" : "";
  const lines: UsageLine[] = [
    {
      serviceCode: "AmazonRDS",
      usageType: `${prefix}${multiAz ? "Multi-AZUsage" : "InstanceUsage"}:${cls}`,
      operation,
      amount: HOURS_PER_MONTH,
      description: `${cls} ${engine}${multiAz ? " Multi-AZ" : azNote} (${HOURS_PER_MONTH} h)`,
    },
  ];
  const partial: string[] = [];
  const excluded: string[] = [];
  // Default per the RDS CreateDBInstance API reference: io1 with Iops, otherwise gp3.
  const setType = readSet(str, attrs, unknown, "storage_type", env);
  // The default depends on whether Iops is specified, i.e. written in the configuration.
  const iopsWritten =
    typeof attrs.iops === "number" || env.context.configured?.has("iops") === true;
  const iopsKnown = typeof attrs.iops === "number";
  const storageType =
    setType !== undefined ? setType : iopsWritten ? (iopsKnown ? "io1" : "unknown") : "gp3";
  const size = read(num, attrs, unknown, "allocated_storage");
  if (size === undefined || size === "unknown") {
    partial.push("storage size is not known until apply");
  } else if (storageType === undefined || storageType === "unknown") {
    partial.push("storage type is not known until apply");
  } else {
    const storage = RDS_STORAGE[storageType];
    if (storage === undefined) {
      partial.push(`${storageType} storage is not supported`);
    } else {
      lines.push({
        serviceCode: "AmazonRDS",
        usageType: prefix + (multiAz ? storage.multi : storage.single),
        operation,
        amount: size,
        description: `${storageType} storage ${size} GB`,
      });
      if (storage.iops !== undefined) {
        const piops = read(num, attrs, unknown, "iops");
        if (piops === "unknown") {
          partial.push("provisioned IOPS is not known until apply");
        } else if (piops !== undefined && piops > 0) {
          lines.push({
            serviceCode: "AmazonRDS",
            usageType: prefix + (multiAz ? storage.iops.multi : storage.iops.single),
            operation,
            amount: piops,
            description: `${piops} provisioned IOPS`,
          });
        }
      }
      // An unset (computed) value means the baseline; only an explicit value above it can cost more.
      const iops = num(attrs, "iops");
      const throughput = num(attrs, "storage_throughput");
      if (storageType === "gp3" && ((iops ?? 0) > 3000 || (throughput ?? 0) > 125)) {
        partial.push("gp3 IOPS and throughput above the baseline are not supported");
      }
    }
  }
  excluded.push("RDS backup storage beyond the free allowance", "data transfer");
  return { lines, partial, excluded };
};

// ---------------------------------------------------------------- VPC / ELB

const natGateway: Estimator = (_attrs, _unknown, prefix) => ({
  lines: [
    {
      serviceCode: "AmazonEC2",
      usageType: `${prefix}NatGateway-Hours`,
      operation: "NatGateway",
      amount: HOURS_PER_MONTH,
      description: `NAT gateway (${HOURS_PER_MONTH} h)`,
    },
  ],
  partial: [],
  excluded: ["NAT gateway data processing (per GB)"],
});

const LB_OPERATIONS: Readonly<Record<string, string>> = {
  application: "LoadBalancing:Application",
  network: "LoadBalancing:Network",
  gateway: "LoadBalancing:Gateway",
};

const loadBalancer: Estimator = (attrs, unknown, prefix) => {
  if (isUnknown(unknown, "load_balancer_type")) {
    return unestimable("load balancer type is not known until apply");
  }
  const type = str(attrs, "load_balancer_type") ?? "application";
  const operation = LB_OPERATIONS[type];
  if (operation === undefined) return unestimable(`load balancer type "${type}" is not supported`);
  return {
    lines: [
      {
        serviceCode: "AWSELB",
        usageType: `${prefix}LoadBalancerUsage`,
        operation,
        amount: HOURS_PER_MONTH,
        description: `${type} load balancer (${HOURS_PER_MONTH} h)`,
      },
    ],
    partial: [],
    excluded: ["load balancer capacity units (LCU, depend on traffic)"],
  };
};

// ---------------------------------------------------------------- public IPv4 / VPC endpoints

/** Amazon VPC bills us-east-1 usage with the USE1- prefix. */
function publicIpv4(env: Env, description: string): UsageLine {
  return {
    serviceCode: "AmazonVPC",
    usageType: `${env.px("use1")}PublicIPv4:InUseAddress`,
    operation: "",
    amount: HOURS_PER_MONTH,
    description: `${description} (${HOURS_PER_MONTH} h)`,
  };
}

const eip: Estimator = (_attrs, _unknown, _prefix, env) => ({
  lines: [publicIpv4(env, "public IPv4 address")],
  partial: [],
  excluded: [],
});

/** Number of elements of a list attribute, even when the elements are known only after apply. */
function listLength(attrs: Attributes, unknown: Attributes, key: string): number | undefined {
  if (unknown[key] === true) return undefined;
  const v = attrs[key];
  return Array.isArray(v) ? v.length : undefined;
}

const vpcEndpoint: Estimator = (attrs, unknown, _prefix, env) => {
  if (isUnknown(unknown, "vpc_endpoint_type")) {
    return unestimable("endpoint type is not known until apply");
  }
  const type = str(attrs, "vpc_endpoint_type") ?? "Gateway";
  if (type === "Gateway") {
    return { lines: [], partial: [], excluded: [] };
  }
  const usageType =
    type === "Interface"
      ? "VpcEndpoint-Hours"
      : type === "GatewayLoadBalancer"
        ? "VpcEndpoint-GWLBE-Hours"
        : undefined;
  if (usageType === undefined) return unestimable(`endpoint type "${type}" is not supported`);
  const subnets = listLength(attrs, unknown, "subnet_ids");
  if (subnets === undefined) return unestimable("number of subnets is not known until apply");
  return {
    lines: [
      {
        serviceCode: "AmazonVPC",
        usageType: `${env.px("use1")}${usageType}`,
        operation: "VpcEndpoint",
        amount: HOURS_PER_MONTH * subnets,
        description: `${type} endpoint in ${subnets} subnet${subnets === 1 ? "" : "s"} (${HOURS_PER_MONTH} h each)`,
      },
    ],
    partial: [],
    excluded: ["VPC endpoint data processing (per GB)"],
  };
};

// ---------------------------------------------------------------- ElastiCache

/** Engine -> operation code, verified against the Price List API (2026-11-21). */
const CACHE_ENGINES: Readonly<Record<string, string>> = {
  memcached: "CreateCacheCluster:0001",
  redis: "CreateCacheCluster:0002",
  valkey: "CreateCacheCluster:Valkey",
};

function cacheNodes(
  engine: string | undefined,
  nodeType: string | undefined,
  nodes: number,
  prefix: string,
): UsageResult {
  const e = engine ?? "redis";
  const operation = CACHE_ENGINES[e];
  if (operation === undefined) return unestimable(`engine "${e}" is not supported`);
  if (nodeType === undefined) return unestimable("node type is not known until apply");
  return {
    lines: [
      {
        serviceCode: "AmazonElastiCache",
        usageType: `${prefix}NodeUsage:${nodeType}`,
        operation,
        amount: HOURS_PER_MONTH * nodes,
        description: `${nodes} × ${nodeType} ${e} (${HOURS_PER_MONTH} h each)`,
      },
    ],
    partial: [],
    excluded: ["ElastiCache backup storage beyond the free allowance", "data transfer"],
  };
}

const elasticacheCluster: Estimator = (attrs, unknown, prefix, env) => {
  // With replication_group_id the cluster adds a read replica to the group: one more node that
  // the group's num_cache_clusters does not count, whose node type comes from the group.
  const group = readSet(str, attrs, unknown, "replication_group_id", env);
  if (group === "unknown") {
    return unestimable("replication group membership is not known until apply");
  }
  if (group !== undefined) {
    return unestimable(
      `read replica added to replication group ${group}; its node type comes from the group`,
    );
  }
  if (isUnknown(unknown, "engine")) return unestimable("engine is not known until apply");
  const nodes = read(num, attrs, unknown, "num_cache_nodes");
  if (nodes === "unknown") return unestimable("number of nodes is not known until apply");
  return cacheNodes(
    str(attrs, "engine"),
    isUnknown(unknown, "node_type") ? undefined : str(attrs, "node_type"),
    nodes ?? 1,
    prefix,
  );
};

const elasticacheReplicationGroup: Estimator = (attrs, unknown, prefix, env) => {
  // Defaults per the provider documentation: engine "redis", num_cache_clusters 1.
  if (readSet(str, attrs, unknown, "engine", env) === "unknown") {
    return unestimable("engine is not known until apply");
  }
  const shards = readSet(num, attrs, unknown, "num_node_groups", env);
  const replicas = readSet(num, attrs, unknown, "replicas_per_node_group", env);
  const setClusters = readSet(num, attrs, unknown, "num_cache_clusters", env);
  const clusters =
    setClusters === undefined && shards === undefined && replicas === undefined ? 1 : setClusters;
  let nodes: number | undefined;
  // NumNodeGroups defaults to 1 per the ElastiCache CreateReplicationGroup API reference.
  if (shards === undefined && typeof replicas === "number" && setClusters === undefined) {
    nodes = replicas + 1;
  } else if (typeof shards === "number" && shards > 1) {
    nodes = typeof replicas === "number" ? shards * (replicas + 1) : undefined;
  } else if (typeof clusters === "number") {
    nodes = clusters;
  } else if (typeof shards === "number" && typeof replicas === "number") {
    nodes = shards * (replicas + 1);
  }
  if (nodes === undefined) return unestimable("number of nodes is not known until apply");
  return cacheNodes(
    str(attrs, "engine"),
    isUnknown(unknown, "node_type") ? undefined : str(attrs, "node_type"),
    nodes,
    prefix,
  );
};

// ---------------------------------------------------------------- Aurora

/** Engine -> operation code, verified against the Price List API (2026-11-21). */
const AURORA_ENGINES: Readonly<Record<string, string>> = {
  "aurora-mysql": "CreateDBInstance:0016",
  "aurora-postgresql": "CreateDBInstance:0021",
};

const AURORA_USAGE_EXCLUDED = [
  "Aurora storage and I/O (depend on usage)",
  "Aurora backup storage beyond the free allowance",
];

const rdsCluster: Estimator = (attrs, unknown) => {
  const engine = str(attrs, "engine");
  if (isUnknown(unknown, "engine")) return unestimable("engine is not known until apply");
  // A Multi-AZ DB cluster (non-Aurora engine, instances described on the cluster) has no
  // aws_rds_cluster_instance resources, so its cost would vanish here.
  if (
    (engine !== undefined && !engine.startsWith("aurora")) ||
    str(attrs, "db_cluster_instance_class") !== undefined ||
    isUnknown(unknown, "db_cluster_instance_class")
  ) {
    return unestimable("Multi-AZ DB clusters are not supported");
  }
  const mode = str(attrs, "engine_mode");
  if (mode !== undefined && mode !== "provisioned") {
    return unestimable(`engine mode "${mode}" is not supported`);
  }
  // Instances are separate resources; the cluster itself is billed by storage and I/O used.
  return { lines: [], partial: [], excluded: AURORA_USAGE_EXCLUDED };
};

const rdsClusterInstance: Estimator = (attrs, unknown, prefix, env) => {
  const engine = str(attrs, "engine");
  if (engine === undefined || isUnknown(unknown, "engine")) {
    return unestimable("engine is not known until apply");
  }
  const operation = AURORA_ENGINES[engine];
  if (operation === undefined) return unestimable(`engine "${engine}" is not supported`);
  const cls = str(attrs, "instance_class");
  if (cls === undefined || isUnknown(unknown, "instance_class")) {
    return unestimable("instance class is not known until apply");
  }
  if (cls === "db.serverless") {
    return unestimable("Aurora Serverless v2 is billed by the capacity it uses");
  }
  const storage = env.context.auroraStorageType;
  const ioOptimized = storage === "aurora-iopt1";
  const partial =
    storage === undefined
      ? [
          "storage type of the cluster could not be read; priced as Aurora Standard (I/O-Optimized costs more per hour)",
        ]
      : [];
  return {
    lines: [
      {
        serviceCode: "AmazonRDS",
        usageType: `${prefix}${ioOptimized ? "InstanceUsageIOOptimized" : "InstanceUsage"}:${cls}`,
        operation,
        amount: HOURS_PER_MONTH,
        description: `${cls} ${engine}${ioOptimized ? " I/O-Optimized" : ""} (${HOURS_PER_MONTH} h)`,
      },
    ],
    partial,
    excluded: AURORA_USAGE_EXCLUDED,
  };
};

// ---------------------------------------------------------------- EKS

const eksCluster: Estimator = (_attrs, _unknown, _prefix, env) => ({
  lines: [
    {
      serviceCode: "AmazonEKS",
      usageType: `${env.px("use1")}AmazonEKS-Hours:perCluster`,
      operation: "CreateOperation",
      amount: HOURS_PER_MONTH,
      description: `EKS cluster (${HOURS_PER_MONTH} h)`,
    },
  ],
  partial: [],
  excluded: [
    "EKS extended support surcharge for Kubernetes versions past standard support",
    "EKS worker nodes (priced as their own resources when they are aws_instance)",
  ],
});

// ---------------------------------------------------------------- OpenSearch

const OPENSEARCH_STORAGE: Readonly<Record<string, string>> = {
  gp2: "ES:GP2-Storage",
  gp3: "ES:GP3-Storage",
  io1: "ES:PIOPS-Storage",
  standard: "ES:Magnetic-Storage",
};

/** "r6g.large.search" / "t3.small.elasticsearch" -> "r6g.large" */
const searchInstance = (type: string) => type.replace(/\.(search|elasticsearch)$/, "");

const openSearchDomain: Estimator = (attrs, unknown, prefix, env) => {
  const cluster = blocks(attrs, "cluster_config")[0] ?? {};
  const cu = blockUnknown(unknown, "cluster_config", 0);
  if (isUnknown(unknown, "cluster_config") || cu.instance_type === true) {
    return unestimable("instance type is not known until apply");
  }
  const type = str(cluster, "instance_type");
  if (type === undefined) return unestimable("instance type is not set in cluster_config");
  const count = cu.instance_count === true ? undefined : (num(cluster, "instance_count") ?? 1);
  if (count === undefined) return unestimable("number of instances is not known until apply");
  const line = (usageType: string, amount: number, description: string): UsageLine => ({
    serviceCode: "AmazonES",
    usageType: prefix + usageType,
    operation: "ESDomain",
    amount,
    description,
  });
  const lines = [
    line(
      `ESInstance:${searchInstance(type)}`,
      HOURS_PER_MONTH * count,
      `${count} × ${type} data node${count === 1 ? "" : "s"} (${HOURS_PER_MONTH} h each)`,
    ),
  ];
  const partial: string[] = [];
  if (cu.dedicated_master_enabled === true) {
    partial.push("dedicated master nodes are not known until apply");
  } else if (cluster.dedicated_master_enabled === true) {
    const masterType = str(cluster, "dedicated_master_type");
    const masters = num(cluster, "dedicated_master_count");
    if (masterType === undefined || masters === undefined) {
      partial.push("dedicated master nodes are not known until apply");
    } else {
      lines.push(
        line(
          `ESInstance:${searchInstance(masterType)}`,
          HOURS_PER_MONTH * masters,
          `${masters} × ${masterType} master node${masters === 1 ? "" : "s"} (${HOURS_PER_MONTH} h each)`,
        ),
      );
    }
  }
  if (cluster.warm_enabled === true) partial.push("UltraWarm nodes are not supported");

  const ebs = blocks(attrs, "ebs_options")[0];
  const eu = blockUnknown(unknown, "ebs_options", 0);
  // ebs_options is "known after apply" both when it is left out and when it is written as a
  // dynamic block (which the configuration does not show), so the two cannot be told apart.
  const ebsOptionsUnknown = isUnknown(unknown, "ebs_options");
  const ebsUnknown =
    eu.ebs_enabled === true ||
    (ebsOptionsUnknown && env.context.configured?.has("ebs_options") !== false);
  const excluded = ["OpenSearch snapshots and data transfer"];
  if (ebsOptionsUnknown && !ebsUnknown) {
    excluded.push("OpenSearch EBS storage written as a dynamic ebs_options block");
  }
  if (ebsUnknown) {
    partial.push("EBS storage is not known until apply");
  } else if (ebs !== undefined && ebs.ebs_enabled === true) {
    const volumeType = eu.volume_type === true ? undefined : (str(ebs, "volume_type") ?? "gp2");
    const size = eu.volume_size === true ? undefined : num(ebs, "volume_size");
    const storage = volumeType === undefined ? undefined : OPENSEARCH_STORAGE[volumeType];
    if (size === undefined || volumeType === undefined) {
      partial.push("EBS storage is not known until apply");
    } else if (storage === undefined) {
      partial.push(`${volumeType} storage is not supported`);
    } else {
      lines.push(line(storage, size * count, `${volumeType} storage ${size} GB × ${count}`));
      const iops = num(ebs, "iops");
      if (volumeType === "io1") {
        if (eu.iops === true) partial.push("provisioned IOPS is not known until apply");
        else if (iops !== undefined && iops > 0) {
          lines.push(line("ES:PIOPS", iops * count, `${iops} provisioned IOPS × ${count}`));
        }
      }
      const throughput = num(ebs, "throughput");
      if (volumeType === "gp3" && ((iops ?? 0) > 3000 || (throughput ?? 0) > 125)) {
        partial.push("gp3 IOPS and throughput above the baseline are not supported");
      }
    }
  }
  return { lines, partial, excluded };
};

// ---------------------------------------------------------------- registry

const ESTIMATORS: Readonly<Record<string, Estimator>> = {
  aws_instance: instance,
  aws_ebs_volume: ebsVolume,
  aws_db_instance: dbInstance,
  aws_nat_gateway: natGateway,
  aws_lb: loadBalancer,
  aws_alb: loadBalancer,
  aws_eip: eip,
  aws_vpc_endpoint: vpcEndpoint,
  aws_elasticache_cluster: elasticacheCluster,
  aws_elasticache_replication_group: elasticacheReplicationGroup,
  aws_rds_cluster: rdsCluster,
  aws_rds_cluster_instance: rdsClusterInstance,
  aws_eks_cluster: eksCluster,
  aws_opensearch_domain: openSearchDomain,
  aws_elasticsearch_domain: openSearchDomain,
};

export function supportedTypes(): string[] {
  return Object.keys(ESTIMATORS);
}

export function isSupportedType(type: string): boolean {
  return type in ESTIMATORS;
}

/** Whether the resource type belongs to an AWS provider (aws or awscc), so it may cost money. */
export function isAwsType(type: string): boolean {
  return /^aws(cc)?_/.test(type);
}

/**
 * Turns the attributes of one resource (the `before` or `after` of a plan's resource change)
 * into monthly usage lines.
 */
export function estimateUsage(
  type: string,
  attrs: Attributes,
  unknown: Attributes,
  region: string,
  context: UsageContext = {},
): UsageResult {
  const estimator = ESTIMATORS[type];
  if (estimator === undefined) return unestimable(`resource type ${type} is not supported`);
  const env: Env = { region, context, px: (style) => usageTypePrefix(region, style) };
  return estimator(attrs, unknown, usageTypePrefix(region), env);
}
