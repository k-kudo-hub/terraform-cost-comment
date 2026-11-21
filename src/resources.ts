import { usageTypePrefix } from "./regions.js";
import type { Attributes, UsageLine, UsageResult } from "./types.js";

/** Hours in a month, the figure AWS Pricing Calculator uses. */
export const HOURS_PER_MONTH = 730;

type Estimator = (attrs: Attributes, unknown: Attributes, prefix: string) => UsageResult;

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

const ebsVolume: Estimator = (attrs, unknown, prefix) => {
  const type = read(str, attrs, unknown, "type");
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

const instance: Estimator = (attrs, unknown, prefix) => {
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
  return {
    lines,
    partial,
    excluded: ["EC2 operating system licenses other than Linux", "data transfer"],
  };
};

// ---------------------------------------------------------------- RDS

/** Engine -> operation code, verified against the Price List API (2026-11-21). */
const RDS_ENGINES: Readonly<Record<string, string>> = {
  mysql: "CreateDBInstance:0002",
  postgres: "CreateDBInstance:0014",
  mariadb: "CreateDBInstance:0018",
};

const RDS_STORAGE: Readonly<Record<string, { single: string; multi: string }>> = {
  gp2: { single: "RDS:GP2-Storage", multi: "RDS:Multi-AZ-GP2-Storage" },
  gp3: { single: "RDS:GP3-Storage", multi: "RDS:Multi-AZ-GP3-Storage" },
  standard: { single: "RDS:StorageUsage", multi: "RDS:Multi-AZ-StorageUsage" },
};

const dbInstance: Estimator = (attrs, unknown, prefix) => {
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
  if (isUnknown(unknown, "multi_az")) return unestimable("Multi-AZ is not known until apply");
  const multiAz = attrs.multi_az === true;
  const lines: UsageLine[] = [
    {
      serviceCode: "AmazonRDS",
      usageType: `${prefix}${multiAz ? "Multi-AZUsage" : "InstanceUsage"}:${cls}`,
      operation,
      amount: HOURS_PER_MONTH,
      description: `${cls} ${engine}${multiAz ? " Multi-AZ" : ""} (${HOURS_PER_MONTH} h)`,
    },
  ];
  const partial: string[] = [];
  const excluded: string[] = [];
  const storageType = read(str, attrs, unknown, "storage_type");
  const size = read(num, attrs, unknown, "allocated_storage");
  if (size === undefined || size === "unknown") {
    partial.push("storage size is not known until apply");
  } else if (storageType === undefined || storageType === "unknown") {
    partial.push("storage type is not known until apply");
  } else {
    const storage = RDS_STORAGE[storageType];
    if (storage === undefined) {
      partial.push(`${storageType} storage and its provisioned IOPS are not supported`);
    } else {
      lines.push({
        serviceCode: "AmazonRDS",
        usageType: prefix + (multiAz ? storage.multi : storage.single),
        operation,
        amount: size,
        description: `${storageType} storage ${size} GB`,
      });
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

// ---------------------------------------------------------------- registry

const ESTIMATORS: Readonly<Record<string, Estimator>> = {
  aws_instance: instance,
  aws_ebs_volume: ebsVolume,
  aws_db_instance: dbInstance,
  aws_nat_gateway: natGateway,
  aws_lb: loadBalancer,
  aws_alb: loadBalancer,
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
): UsageResult {
  const estimator = ESTIMATORS[type];
  if (estimator === undefined) return unestimable(`resource type ${type} is not supported`);
  return estimator(attrs, unknown, usageTypePrefix(region));
}
