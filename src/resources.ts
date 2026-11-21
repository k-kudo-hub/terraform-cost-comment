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

/**
 * Usage lines of one EBS volume. Returns a reason string when the volume cannot be priced.
 * `label` names the volume in descriptions ("root volume", "volume").
 */
function ebsLines(
  label: string,
  type: string | undefined,
  size: number | undefined,
  iops: number | undefined,
  throughput: number | undefined,
  prefix: string,
): UsageLine[] | string {
  if (size === undefined) return `${label} size is not known until apply`;
  if (type === undefined) return `${label} type is not known until apply`;
  const t = EBS_TYPES[type];
  if (t === undefined) return `${label} type "${type}" is not supported`;
  const line = (usageType: string, amount: number, description: string): UsageLine => ({
    serviceCode: "AmazonEC2",
    usageType: prefix + usageType,
    operation: t.operation,
    amount,
    description,
  });
  const lines = [line(t.storage, size, `${label} ${type} ${size} GB`)];
  if (type === "gp3") {
    if (iops !== undefined && iops > GP3_FREE_IOPS) {
      lines.push(line("EBS:VolumeP-IOPS.gp3", iops - GP3_FREE_IOPS, `${label} IOPS above 3,000`));
    }
    if (throughput !== undefined && throughput > GP3_FREE_THROUGHPUT_MIBPS) {
      lines.push(
        line(
          "EBS:VolumeP-Throughput.gp3",
          (throughput - GP3_FREE_THROUGHPUT_MIBPS) / 1024,
          `${label} throughput above 125 MiB/s`,
        ),
      );
    }
  } else if (type === "io1" && iops !== undefined && iops > 0) {
    lines.push(line("EBS:VolumeP-IOPS.piops", iops, `${label} ${iops} provisioned IOPS`));
  } else if (type === "io2" && iops !== undefined && iops > 0) {
    let rest = iops;
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
  return lines;
}

const ebsVolume: Estimator = (attrs, unknown, prefix) => {
  if (isUnknown(unknown, "size")) return unestimable("volume size is not known until apply");
  const lines = ebsLines(
    "volume",
    str(attrs, "type") ?? (isUnknown(unknown, "type") ? undefined : "gp2"),
    num(attrs, "size"),
    num(attrs, "iops"),
    num(attrs, "throughput"),
    prefix,
  );
  if (typeof lines === "string") return unestimable(lines);
  return { lines, excluded: ["snapshots"] };
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
  const excluded: string[] = [];
  const volumes: Array<[string, string]> = [
    ["root_block_device", "root volume"],
    ["ebs_block_device", "EBS volume"],
  ];
  for (const [key, label] of volumes) {
    blocks(attrs, key).forEach((block, i) => {
      const u = blockUnknown(unknown, key, i);
      const result = ebsLines(
        label,
        u.volume_type === true ? undefined : str(block, "volume_type"),
        u.volume_size === true ? undefined : num(block, "volume_size"),
        num(block, "iops"),
        num(block, "throughput"),
        prefix,
      );
      if (typeof result === "string") excluded.push(result);
      else lines.push(...result);
    });
  }
  excluded.push("operating system license other than Linux", "data transfer");
  return { lines, excluded };
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
  if (engine === undefined) return unestimable("engine is not known until apply");
  const operation = RDS_ENGINES[engine];
  if (operation === undefined) return unestimable(`engine "${engine}" is not supported`);
  const cls = str(attrs, "instance_class");
  if (cls === undefined || isUnknown(unknown, "instance_class")) {
    return unestimable("instance class is not known until apply");
  }
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
  const excluded: string[] = [];
  const storageType = isUnknown(unknown, "storage_type") ? undefined : str(attrs, "storage_type");
  const size = isUnknown(unknown, "allocated_storage")
    ? undefined
    : num(attrs, "allocated_storage");
  const storage = storageType === undefined ? undefined : RDS_STORAGE[storageType];
  if (size === undefined) {
    excluded.push("storage (size is not known until apply)");
  } else if (storageType === undefined) {
    excluded.push("storage (type is not known until apply)");
  } else if (storage === undefined) {
    excluded.push(`${storageType} storage and provisioned IOPS`);
  } else {
    lines.push({
      serviceCode: "AmazonRDS",
      usageType: prefix + (multiAz ? storage.multi : storage.single),
      operation,
      amount: size,
      description: `${storageType} storage ${size} GB`,
    });
  }
  if (storageType === "gp3") excluded.push("gp3 IOPS and throughput above the baseline");
  excluded.push("backups beyond the free allowance", "data transfer");
  return { lines, excluded };
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
  excluded: ["data processing (per GB)"],
});

const LB_OPERATIONS: Readonly<Record<string, string>> = {
  application: "LoadBalancing:Application",
  network: "LoadBalancing:Network",
  gateway: "LoadBalancing:Gateway",
};

const loadBalancer: Estimator = (attrs, _unknown, prefix) => {
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
    excluded: ["LCU (capacity units, depends on traffic)"],
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
