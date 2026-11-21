import { type PrefixStyle, usageTypePrefix } from "./regions.js";
import { type Attributes, type Msg, msg, type UsageLine, type UsageResult } from "./types.js";

/** Hours in a month, the figure AWS Pricing Calculator uses. */
export const HOURS_PER_MONTH = 730;

const H = HOURS_PER_MONTH;

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

const unestimable = (reason: Msg): UsageResult => ({
  lines: [],
  excluded: [],
  partial: [],
  unestimable: reason,
});

// ---------------------------------------------------------------- shared texts

/** "<what> is not known until apply" */
const unknownUntilApply = (what: Msg, plural = false): Msg =>
  msg(
    `${what.en} ${plural ? "are" : "is"} not known until apply`,
    `${what.ja}が apply まで分からない`,
  );

/** '<what> "<value>" is not supported' */
const notSupported = (what: Msg, value: string): Msg =>
  msg(`${what.en} "${value}" is not supported`, `${what.ja}「${value}」には対応していない`);

const W = {
  engine: msg("engine", "エンジン"),
  instanceType: msg("instance type", "インスタンスタイプ"),
  instanceClass: msg("instance class", "インスタンスクラス"),
  nodeType: msg("node type", "ノードタイプ"),
  nodes: msg("number of nodes", "ノード数"),
  multiAz: msg("Multi-AZ", "マルチ AZ にするか"),
  storageSize: msg("storage size", "ストレージのサイズ"),
  storageType: msg("storage type", "ストレージの種類"),
  piops: msg("provisioned IOPS", "プロビジョンド IOPS"),
  lbType: msg("load balancer type", "ロードバランサーの種類"),
  endpointType: msg("endpoint type", "エンドポイントの種類"),
  subnets: msg("number of subnets", "サブネット数"),
  instances: msg("number of instances", "インスタンス数"),
  masters: msg("dedicated master nodes", "専用マスターノード"),
  ebsStorage: msg("EBS storage", "EBS ストレージ"),
  tenancy: msg("tenancy", "テナンシー"),
  engineMode: msg("engine mode", "エンジンモード"),
  membership: msg("replication group membership", "レプリケーショングループに加わるか"),
};

const DATA_TRANSFER = msg("data transfer", "データ転送");
const GP3_ABOVE_BASELINE = msg(
  "gp3 IOPS and throughput above the baseline are not supported",
  "基準を超える gp3 の IOPS とスループットには対応していない",
);

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
const IO2_TIERS: ReadonlyArray<{ suffix: string; size: number; ja: string }> = [
  { suffix: "", size: 32000, ja: "" },
  { suffix: ".tier2", size: 32000, ja: "（第2段階）" },
  { suffix: ".tier3", size: Number.POSITIVE_INFINITY, ja: "（第3段階）" },
];

const VOLUME = msg("volume", "ボリューム");
const ROOT_VOLUME = msg("root volume", "ルートボリューム");
const EBS_VOLUME = msg("EBS volume", "EBS ボリューム");

/** One EBS volume's attributes; `undefined` = not set, "unknown" = known only after apply. */
interface EbsSpec {
  label: Msg;
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
): { lines: UsageLine[]; partial: Msg[]; unestimable?: Msg } {
  const { label, type, size, iops, throughput } = spec;
  const of = (en: string, ja: string) => msg(`${label.en} ${en}`, `${label.ja}の${ja}`);
  if (size === undefined || size === "unknown") {
    return { lines: [], partial: [], unestimable: unknownUntilApply(of("size", "サイズ")) };
  }
  if (type === undefined || type === "unknown") {
    return { lines: [], partial: [], unestimable: unknownUntilApply(of("type", "種類")) };
  }
  const t = EBS_TYPES[type];
  if (t === undefined) {
    return { lines: [], partial: [], unestimable: notSupported(of("type", "種類"), type) };
  }
  const line = (usageType: string, amount: number, description: Msg): UsageLine => ({
    serviceCode: "AmazonEC2",
    usageType: prefix + usageType,
    operation: t.operation,
    amount,
    description,
  });
  const lines = [
    line(t.storage, size, msg(`${label.en} ${type} ${size} GB`, `${label.ja} ${type} ${size} GB`)),
  ];
  const partial: Msg[] = [];
  // gp3 IOPS and throughput left unset are computed at the free baseline, so only io1/io2
  // (where IOPS are always charged) need a value to be priced.
  if ((type === "io1" || type === "io2") && iops === "unknown") {
    partial.push(unknownUntilApply(of("IOPS", "IOPS")));
  }
  const knownIops = typeof iops === "number" ? iops : undefined;
  const knownThroughput = typeof throughput === "number" ? throughput : undefined;
  if (type === "gp3") {
    if (knownIops !== undefined && knownIops > GP3_FREE_IOPS) {
      lines.push(
        line(
          "EBS:VolumeP-IOPS.gp3",
          knownIops - GP3_FREE_IOPS,
          of("IOPS above 3,000", "3,000 を超える IOPS"),
        ),
      );
    }
    if (knownThroughput !== undefined && knownThroughput > GP3_FREE_THROUGHPUT_MIBPS) {
      lines.push(
        line(
          "EBS:VolumeP-Throughput.gp3",
          (knownThroughput - GP3_FREE_THROUGHPUT_MIBPS) / 1024,
          of("throughput above 125 MiB/s", "125 MiB/s を超えるスループット"),
        ),
      );
    }
  } else if (type === "io1" && knownIops !== undefined && knownIops > 0) {
    lines.push(
      line(
        "EBS:VolumeP-IOPS.piops",
        knownIops,
        of(`${knownIops} provisioned IOPS`, `プロビジョンド IOPS ${knownIops}`),
      ),
    );
  } else if (type === "io2" && knownIops !== undefined && knownIops > 0) {
    let rest = knownIops;
    for (const tier of IO2_TIERS) {
      if (rest <= 0) break;
      const amount = Math.min(rest, tier.size);
      lines.push(
        line(
          `EBS:VolumeP-IOPS.io2${tier.suffix}`,
          amount,
          of(`provisioned IOPS${tier.suffix}`, `プロビジョンド IOPS${tier.ja}`),
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
      label: VOLUME,
      type: type ?? "gp2",
      size: read(num, attrs, unknown, "size"),
      iops: read(num, attrs, unknown, "iops"),
      throughput: read(num, attrs, unknown, "throughput"),
    },
    prefix,
  );
  if (result.unestimable !== undefined) return unestimable(result.unestimable);
  return {
    lines: result.lines,
    partial: result.partial,
    excluded: [msg("EBS snapshots", "EBS のスナップショット")],
  };
};

// ---------------------------------------------------------------- EC2

const instance: Estimator = (attrs, unknown, prefix, env) => {
  const type = str(attrs, "instance_type");
  if (type === undefined || isUnknown(unknown, "instance_type")) {
    return unestimable(unknownUntilApply(W.instanceType));
  }
  const tenancy = str(attrs, "tenancy");
  if (tenancy !== undefined && tenancy !== "default") {
    return unestimable(notSupported(W.tenancy, tenancy));
  }
  const lines: UsageLine[] = [
    {
      serviceCode: "AmazonEC2",
      usageType: `${prefix}BoxUsage:${type}`,
      operation: "RunInstances",
      amount: H,
      description: msg(
        `${type} Linux on-demand (${H} h)`,
        `${type} Linux オンデマンド（${H} 時間）`,
      ),
    },
  ];
  const partial: Msg[] = [];
  const volumes: Array<[string, Msg]> = [
    ["root_block_device", ROOT_VOLUME],
    ["ebs_block_device", EBS_VOLUME],
  ];
  for (const [key, label] of volumes) {
    if (isUnknown(unknown, key)) {
      // A root volume always exists; left unconfigured, its size comes from the AMI.
      // ebs_block_device is wholly unknown when none is configured, so there is nothing to price.
      if (key === "root_block_device") {
        partial.push(
          unknownUntilApply(
            msg("root volume size (from the AMI)", "ルートボリュームのサイズ（AMI で決まる）"),
          ),
        );
      }
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
  const excluded = [
    msg("EC2 operating system licenses other than Linux", "Linux 以外の EC2 の OS ライセンス"),
    DATA_TRANSFER,
  ];
  // Only an explicit request: left unset, the subnet decides and the plan cannot tell.
  if (attrs.associate_public_ip_address === true) {
    lines.push(publicIpv4(env));
  } else if (isUnknown(unknown, "associate_public_ip_address")) {
    excluded.push(
      msg(
        "EC2 public IPv4 address when the subnet assigns one",
        "サブネットが割り当てる EC2 のパブリック IPv4 アドレス",
      ),
    );
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

const storageLine = (type: string, size: number, suffix = ""): Msg =>
  msg(`${type} storage ${size} GB${suffix}`, `${type} ストレージ ${size} GB${suffix}`);

const dbInstance: Estimator = (attrs, unknown, prefix, env) => {
  const engine = str(attrs, "engine");
  if (engine === undefined || isUnknown(unknown, "engine")) {
    return unestimable(unknownUntilApply(W.engine));
  }
  const operation = RDS_ENGINES[engine];
  if (operation === undefined) return unestimable(notSupported(W.engine, engine));
  const cls = str(attrs, "instance_class");
  if (cls === undefined || isUnknown(unknown, "instance_class")) {
    return unestimable(unknownUntilApply(W.instanceClass));
  }
  const multiAzValue = readSet((a, k) => a[k], attrs, unknown, "multi_az", env);
  if (multiAzValue === "unknown") return unestimable(unknownUntilApply(W.multiAz));
  const multiAz = multiAzValue === true;
  // The RDS API reference states no default for MultiAZ; say so when we assume Single-AZ.
  const az = multiAz
    ? msg(" Multi-AZ", " マルチ AZ")
    : multiAzValue === undefined
      ? msg(" Single-AZ (multi_az not set)", " シングル AZ・multi_az の指定なし")
      : msg("", "");
  const lines: UsageLine[] = [
    {
      serviceCode: "AmazonRDS",
      usageType: `${prefix}${multiAz ? "Multi-AZUsage" : "InstanceUsage"}:${cls}`,
      operation,
      amount: H,
      description: msg(
        `${cls} ${engine}${az.en} (${H} h)`,
        `${cls} ${engine}${az.ja}（${H} 時間）`,
      ),
    },
  ];
  const partial: Msg[] = [];
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
    partial.push(unknownUntilApply(W.storageSize));
  } else if (storageType === undefined || storageType === "unknown") {
    partial.push(unknownUntilApply(W.storageType));
  } else {
    const storage = RDS_STORAGE[storageType];
    if (storage === undefined) {
      partial.push(notSupported(W.storageType, storageType));
    } else {
      lines.push({
        serviceCode: "AmazonRDS",
        usageType: prefix + (multiAz ? storage.multi : storage.single),
        operation,
        amount: size,
        description: storageLine(storageType, size),
      });
      if (storage.iops !== undefined) {
        const piops = read(num, attrs, unknown, "iops");
        if (piops === "unknown") {
          partial.push(unknownUntilApply(W.piops));
        } else if (piops !== undefined && piops > 0) {
          lines.push({
            serviceCode: "AmazonRDS",
            usageType: prefix + (multiAz ? storage.iops.multi : storage.iops.single),
            operation,
            amount: piops,
            description: msg(`${piops} provisioned IOPS`, `プロビジョンド IOPS ${piops}`),
          });
        }
      }
      // An unset (computed) value means the baseline; only an explicit value above it can cost more.
      const iops = num(attrs, "iops");
      const throughput = num(attrs, "storage_throughput");
      if (storageType === "gp3" && ((iops ?? 0) > 3000 || (throughput ?? 0) > 125)) {
        partial.push(GP3_ABOVE_BASELINE);
      }
    }
  }
  return {
    lines,
    partial,
    excluded: [
      msg(
        "RDS backup storage beyond the free allowance",
        "無料枠を超える RDS のバックアップストレージ",
      ),
      DATA_TRANSFER,
    ],
  };
};

// ---------------------------------------------------------------- VPC / ELB

const natGateway: Estimator = (_attrs, _unknown, prefix) => ({
  lines: [
    {
      serviceCode: "AmazonEC2",
      usageType: `${prefix}NatGateway-Hours`,
      operation: "NatGateway",
      amount: H,
      description: msg(`NAT gateway (${H} h)`, `NAT ゲートウェイ（${H} 時間）`),
    },
  ],
  partial: [],
  excluded: [
    msg("NAT gateway data processing (per GB)", "NAT ゲートウェイのデータ処理（GB 単位）"),
  ],
});

const LB_OPERATIONS: Readonly<Record<string, string>> = {
  application: "LoadBalancing:Application",
  network: "LoadBalancing:Network",
  gateway: "LoadBalancing:Gateway",
};

const LB_NAMES_JA: Readonly<Record<string, string>> = {
  application: "Application Load Balancer",
  network: "Network Load Balancer",
  gateway: "Gateway Load Balancer",
};

const loadBalancer: Estimator = (attrs, unknown, prefix) => {
  if (isUnknown(unknown, "load_balancer_type")) {
    return unestimable(unknownUntilApply(W.lbType));
  }
  const type = str(attrs, "load_balancer_type") ?? "application";
  const operation = LB_OPERATIONS[type];
  if (operation === undefined) return unestimable(notSupported(W.lbType, type));
  return {
    lines: [
      {
        serviceCode: "AWSELB",
        usageType: `${prefix}LoadBalancerUsage`,
        operation,
        amount: H,
        description: msg(
          `${type} load balancer (${H} h)`,
          `${LB_NAMES_JA[type] ?? type}（${H} 時間）`,
        ),
      },
    ],
    partial: [],
    excluded: [
      msg(
        "load balancer capacity units (LCU, depend on traffic)",
        "ロードバランサーのキャパシティユニット（LCU。通信量で決まる）",
      ),
    ],
  };
};

// ---------------------------------------------------------------- public IPv4 / VPC endpoints

/** Amazon VPC bills us-east-1 usage with the USE1- prefix. */
function publicIpv4(env: Env): UsageLine {
  return {
    serviceCode: "AmazonVPC",
    usageType: `${env.px("use1")}PublicIPv4:InUseAddress`,
    operation: "",
    amount: H,
    description: msg(`public IPv4 address (${H} h)`, `パブリック IPv4 アドレス（${H} 時間）`),
  };
}

const eip: Estimator = (_attrs, _unknown, _prefix, env) => ({
  lines: [publicIpv4(env)],
  partial: [],
  excluded: [],
});

/** Number of elements of a list attribute, even when the elements are known only after apply. */
function listLength(attrs: Attributes, unknown: Attributes, key: string): number | undefined {
  if (unknown[key] === true) return undefined;
  const v = attrs[key];
  return Array.isArray(v) ? v.length : undefined;
}

const ENDPOINT_NAMES_JA: Readonly<Record<string, string>> = {
  Interface: "インターフェイス型エンドポイント",
  GatewayLoadBalancer: "Gateway Load Balancer 型エンドポイント",
};

const vpcEndpoint: Estimator = (attrs, unknown, _prefix, env) => {
  if (isUnknown(unknown, "vpc_endpoint_type")) {
    return unestimable(unknownUntilApply(W.endpointType));
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
  if (usageType === undefined) return unestimable(notSupported(W.endpointType, type));
  const subnets = listLength(attrs, unknown, "subnet_ids");
  if (subnets === undefined) return unestimable(unknownUntilApply(W.subnets));
  return {
    lines: [
      {
        serviceCode: "AmazonVPC",
        usageType: `${env.px("use1")}${usageType}`,
        operation: "VpcEndpoint",
        amount: H * subnets,
        description: msg(
          `${type} endpoint in ${subnets} subnet${subnets === 1 ? "" : "s"} (${H} h each)`,
          `${ENDPOINT_NAMES_JA[type] ?? type}、サブネット ${subnets} 個（各 ${H} 時間）`,
        ),
      },
    ],
    partial: [],
    excluded: [
      msg("VPC endpoint data processing (per GB)", "VPC エンドポイントのデータ処理（GB 単位）"),
    ],
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
  if (operation === undefined) return unestimable(notSupported(W.engine, e));
  if (nodeType === undefined) return unestimable(unknownUntilApply(W.nodeType));
  return {
    lines: [
      {
        serviceCode: "AmazonElastiCache",
        usageType: `${prefix}NodeUsage:${nodeType}`,
        operation,
        amount: H * nodes,
        description: msg(
          `${nodes} × ${nodeType} ${e} (${H} h each)`,
          `${nodeType} ${e} × ${nodes}（各 ${H} 時間）`,
        ),
      },
    ],
    partial: [],
    excluded: [
      msg(
        "ElastiCache backup storage beyond the free allowance",
        "無料枠を超える ElastiCache のバックアップストレージ",
      ),
      DATA_TRANSFER,
    ],
  };
}

const elasticacheCluster: Estimator = (attrs, unknown, prefix, env) => {
  // With replication_group_id the cluster adds a read replica to the group: one more node that
  // the group's num_cache_clusters does not count, whose node type comes from the group.
  const group = readSet(str, attrs, unknown, "replication_group_id", env);
  if (group === "unknown") return unestimable(unknownUntilApply(W.membership));
  if (group !== undefined) {
    return unestimable(
      msg(
        `read replica added to replication group ${group}; its node type comes from the group`,
        `レプリケーショングループ ${group} に足すリードレプリカで、ノードタイプはグループで決まる`,
      ),
    );
  }
  if (isUnknown(unknown, "engine")) return unestimable(unknownUntilApply(W.engine));
  const nodes = read(num, attrs, unknown, "num_cache_nodes");
  if (nodes === "unknown") return unestimable(unknownUntilApply(W.nodes));
  return cacheNodes(
    str(attrs, "engine"),
    isUnknown(unknown, "node_type") ? undefined : str(attrs, "node_type"),
    nodes ?? 1,
    prefix,
  );
};

const elasticacheReplicationGroup: Estimator = (attrs, unknown, prefix, env) => {
  // Defaults: engine "redis" (provider implementation), num_cache_clusters 1 (provider docs).
  if (readSet(str, attrs, unknown, "engine", env) === "unknown") {
    return unestimable(unknownUntilApply(W.engine));
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
  if (nodes === undefined) return unestimable(unknownUntilApply(W.nodes));
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

const AURORA_USAGE_EXCLUDED: Msg[] = [
  msg("Aurora storage and I/O (depend on usage)", "Aurora のストレージと I/O（使用量で決まる）"),
  msg(
    "Aurora backup storage beyond the free allowance",
    "無料枠を超える Aurora のバックアップストレージ",
  ),
];

const rdsCluster: Estimator = (attrs, unknown) => {
  const engine = str(attrs, "engine");
  if (isUnknown(unknown, "engine")) return unestimable(unknownUntilApply(W.engine));
  // A Multi-AZ DB cluster (non-Aurora engine, instances described on the cluster) has no
  // aws_rds_cluster_instance resources, so its cost would vanish here.
  if (
    (engine !== undefined && !engine.startsWith("aurora")) ||
    str(attrs, "db_cluster_instance_class") !== undefined ||
    isUnknown(unknown, "db_cluster_instance_class")
  ) {
    return unestimable(
      msg("Multi-AZ DB clusters are not supported", "マルチ AZ DB クラスターには対応していない"),
    );
  }
  const mode = str(attrs, "engine_mode");
  if (mode !== undefined && mode !== "provisioned") {
    return unestimable(notSupported(W.engineMode, mode));
  }
  // Instances are separate resources; the cluster itself is billed by storage and I/O used.
  return { lines: [], partial: [], excluded: AURORA_USAGE_EXCLUDED };
};

const rdsClusterInstance: Estimator = (attrs, unknown, prefix, env) => {
  const engine = str(attrs, "engine");
  if (engine === undefined || isUnknown(unknown, "engine")) {
    return unestimable(unknownUntilApply(W.engine));
  }
  const operation = AURORA_ENGINES[engine];
  if (operation === undefined) return unestimable(notSupported(W.engine, engine));
  const cls = str(attrs, "instance_class");
  if (cls === undefined || isUnknown(unknown, "instance_class")) {
    return unestimable(unknownUntilApply(W.instanceClass));
  }
  if (cls === "db.serverless") {
    return unestimable(
      msg(
        "Aurora Serverless v2 is billed by the capacity it uses",
        "Aurora Serverless v2 は使った容量で課金される",
      ),
    );
  }
  const storage = env.context.auroraStorageType;
  const ioOptimized = storage === "aurora-iopt1";
  const partial =
    storage === undefined
      ? [
          msg(
            "storage type of the cluster could not be read; priced as Aurora Standard (I/O-Optimized costs more per hour)",
            "クラスターのストレージの種類を読めないため Aurora Standard の単価で試算した（I/O-Optimized なら時間単価が高い）",
          ),
        ]
      : [];
  const io = ioOptimized ? " I/O-Optimized" : "";
  return {
    lines: [
      {
        serviceCode: "AmazonRDS",
        usageType: `${prefix}${ioOptimized ? "InstanceUsageIOOptimized" : "InstanceUsage"}:${cls}`,
        operation,
        amount: H,
        description: msg(`${cls} ${engine}${io} (${H} h)`, `${cls} ${engine}${io}（${H} 時間）`),
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
      amount: H,
      description: msg(`EKS cluster (${H} h)`, `EKS クラスター（${H} 時間）`),
    },
  ],
  partial: [],
  excluded: [
    msg(
      "EKS extended support surcharge for Kubernetes versions past standard support",
      "標準サポートを過ぎた Kubernetes のバージョンにかかる EKS の延長サポート料金",
    ),
    msg(
      "EKS worker nodes (priced as their own resources when they are aws_instance)",
      "EKS のワーカーノード（aws_instance なら、そのリソースとして試算する）",
    ),
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

const nodeLine = (count: number, type: string, en: string, ja: string): Msg =>
  msg(
    `${count} × ${type} ${en}${count === 1 ? "" : "s"} (${H} h each)`,
    `${type} ${ja} × ${count}（各 ${H} 時間）`,
  );

const openSearchDomain: Estimator = (attrs, unknown, prefix, env) => {
  const cluster = blocks(attrs, "cluster_config")[0] ?? {};
  const cu = blockUnknown(unknown, "cluster_config", 0);
  if (isUnknown(unknown, "cluster_config") || cu.instance_type === true) {
    return unestimable(unknownUntilApply(W.instanceType));
  }
  const type = str(cluster, "instance_type");
  if (type === undefined) {
    return unestimable(
      msg(
        "instance type is not set in cluster_config",
        "cluster_config にインスタンスタイプが指定されていない",
      ),
    );
  }
  const count = cu.instance_count === true ? undefined : (num(cluster, "instance_count") ?? 1);
  if (count === undefined) return unestimable(unknownUntilApply(W.instances));
  const line = (usageType: string, amount: number, description: Msg): UsageLine => ({
    serviceCode: "AmazonES",
    usageType: prefix + usageType,
    operation: "ESDomain",
    amount,
    description,
  });
  const lines = [
    line(
      `ESInstance:${searchInstance(type)}`,
      H * count,
      nodeLine(count, type, "data node", "データノード"),
    ),
  ];
  const partial: Msg[] = [];
  if (cu.dedicated_master_enabled === true) {
    partial.push(unknownUntilApply(W.masters, true));
  } else if (cluster.dedicated_master_enabled === true) {
    const masterType = str(cluster, "dedicated_master_type");
    const masters = num(cluster, "dedicated_master_count");
    if (masterType === undefined || masters === undefined) {
      partial.push(unknownUntilApply(W.masters, true));
    } else {
      lines.push(
        line(
          `ESInstance:${searchInstance(masterType)}`,
          H * masters,
          nodeLine(masters, masterType, "master node", "専用マスターノード"),
        ),
      );
    }
  }
  if (cluster.warm_enabled === true) {
    partial.push(msg("UltraWarm nodes are not supported", "UltraWarm ノードには対応していない"));
  }

  const ebs = blocks(attrs, "ebs_options")[0];
  const eu = blockUnknown(unknown, "ebs_options", 0);
  // ebs_options is "known after apply" both when it is left out and when it is written as a
  // dynamic block (which the configuration does not show), so the two cannot be told apart.
  const ebsOptionsUnknown = isUnknown(unknown, "ebs_options");
  const ebsUnknown =
    eu.ebs_enabled === true ||
    (ebsOptionsUnknown && env.context.configured?.has("ebs_options") !== false);
  const excluded = [
    msg("OpenSearch snapshots and data transfer", "OpenSearch のスナップショットとデータ転送"),
  ];
  if (ebsOptionsUnknown && !ebsUnknown) {
    excluded.push(
      msg(
        "OpenSearch EBS storage written as a dynamic ebs_options block",
        "dynamic ブロックで書いた ebs_options の OpenSearch の EBS ストレージ",
      ),
    );
  }
  if (ebsUnknown) {
    partial.push(unknownUntilApply(W.ebsStorage));
  } else if (ebs !== undefined && ebs.ebs_enabled === true) {
    const volumeType = eu.volume_type === true ? undefined : (str(ebs, "volume_type") ?? "gp2");
    const size = eu.volume_size === true ? undefined : num(ebs, "volume_size");
    const storage = volumeType === undefined ? undefined : OPENSEARCH_STORAGE[volumeType];
    if (size === undefined || volumeType === undefined) {
      partial.push(unknownUntilApply(W.ebsStorage));
    } else if (storage === undefined) {
      partial.push(notSupported(W.storageType, volumeType));
    } else {
      lines.push(line(storage, size * count, storageLine(volumeType, size, ` × ${count}`)));
      const iops = num(ebs, "iops");
      if (volumeType === "io1") {
        if (eu.iops === true) partial.push(unknownUntilApply(W.piops));
        else if (iops !== undefined && iops > 0) {
          lines.push(
            line(
              "ES:PIOPS",
              iops * count,
              msg(`${iops} provisioned IOPS × ${count}`, `プロビジョンド IOPS ${iops} × ${count}`),
            ),
          );
        }
      }
      const throughput = num(ebs, "throughput");
      if (volumeType === "gp3" && ((iops ?? 0) > 3000 || (throughput ?? 0) > 125)) {
        partial.push(GP3_ABOVE_BASELINE);
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
  if (estimator === undefined) {
    return unestimable(
      msg(`resource type ${type} is not supported`, `リソースの種類 ${type} には対応していない`),
    );
  }
  const env: Env = { region, context, px: (style) => usageTypePrefix(region, style) };
  return estimator(attrs, unknown, usageTypePrefix(region), env);
}
