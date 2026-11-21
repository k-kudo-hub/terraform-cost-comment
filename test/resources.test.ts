import { describe, expect, it } from "vitest";
import { estimateUsage, isAwsType, isSupportedType } from "../src/resources.js";

const TOKYO = "ap-northeast-1";
const VIRGINIA = "us-east-1";

const usage = (type: string, after: Record<string, unknown>, region = TOKYO, unknown = {}) =>
  estimateUsage(type, after, unknown, region);

describe("isSupportedType", () => {
  it("knows the resource types of the first version", () => {
    for (const t of [
      "aws_instance",
      "aws_ebs_volume",
      "aws_db_instance",
      "aws_nat_gateway",
      "aws_lb",
      "aws_alb",
    ]) {
      expect(isSupportedType(t)).toBe(true);
    }
    expect(isSupportedType("aws_s3_bucket")).toBe(false);
  });
});

describe("aws_instance", () => {
  it("prices instance hours for 730 hours a month with the region prefix", () => {
    const r = usage("aws_instance", { instance_type: "t3.micro" });
    expect(r.lines[0]).toMatchObject({
      serviceCode: "AmazonEC2",
      usageType: "APN1-BoxUsage:t3.micro",
      operation: "RunInstances",
      amount: 730,
    });
  });

  it("uses no prefix in us-east-1", () => {
    const r = usage("aws_instance", { instance_type: "m5.large" }, VIRGINIA);
    expect(r.lines[0]?.usageType).toBe("BoxUsage:m5.large");
  });

  it("adds the root and extra EBS volumes when their size is known", () => {
    const r = usage("aws_instance", {
      instance_type: "t3.micro",
      root_block_device: [{ volume_size: 30, volume_type: "gp3", iops: 3000, throughput: 125 }],
      ebs_block_device: [{ volume_size: 100, volume_type: "gp2" }],
    });
    expect(r.lines.map((l) => [l.usageType, l.amount])).toEqual([
      ["APN1-BoxUsage:t3.micro", 730],
      ["APN1-EBS:VolumeUsage.gp3", 30],
      ["APN1-EBS:VolumeUsage.gp2", 100],
    ]);
  });

  it("reports the root volume as excluded when its size is not known until apply", () => {
    const r = usage("aws_instance", { instance_type: "t3.micro", root_block_device: [{}] }, TOKYO, {
      root_block_device: [{ volume_size: true }],
    });
    expect(r.lines).toHaveLength(1);
    expect(r.partial).toEqual(["root volume size is not known until apply"]);
  });

  it("reports the root volume when the whole block is not known until apply", () => {
    const r = usage("aws_instance", { instance_type: "t3.micro" }, TOKYO, {
      root_block_device: true,
    });
    expect(r.partial).toEqual(["root volume size (from the AMI) is not known until apply"]);
  });

  it("does not flag extra EBS volumes that are not configured", () => {
    const r = usage("aws_instance", { instance_type: "t3.micro" }, TOKYO, {
      ebs_block_device: true,
      root_block_device: [{ iops: true, throughput: true }],
    });
    expect(r.partial).toEqual([]);
  });

  it("cannot estimate an instance whose type is unknown", () => {
    const r = usage("aws_instance", {}, TOKYO, { instance_type: true });
    expect(r.unestimable).toBeDefined();
  });

  it("cannot estimate dedicated tenancy", () => {
    const r = usage("aws_instance", { instance_type: "t3.micro", tenancy: "dedicated" });
    expect(r.unestimable).toContain("tenancy");
  });
});

describe("aws_ebs_volume", () => {
  it("prices gp3 storage and only the IOPS and throughput above the free baseline", () => {
    const r = usage("aws_ebs_volume", { type: "gp3", size: 200, iops: 5000, throughput: 250 });
    expect(r.lines.map((l) => [l.usageType, l.operation, l.amount])).toEqual([
      ["APN1-EBS:VolumeUsage.gp3", "CreateVolume-Gp3", 200],
      ["APN1-EBS:VolumeP-IOPS.gp3", "CreateVolume-Gp3", 2000],
      ["APN1-EBS:VolumeP-Throughput.gp3", "CreateVolume-Gp3", 125 / 1024],
    ]);
  });

  it("does not add IOPS or throughput lines at the gp3 baseline", () => {
    const r = usage("aws_ebs_volume", { type: "gp3", size: 10, iops: 3000, throughput: 125 });
    expect(r.lines).toHaveLength(1);
  });

  it("prices io1 storage and provisioned IOPS", () => {
    const r = usage("aws_ebs_volume", { type: "io1", size: 100, iops: 4000 });
    expect(r.lines.map((l) => [l.usageType, l.operation, l.amount])).toEqual([
      ["APN1-EBS:VolumeUsage.piops", "CreateVolume-P-IOPS", 100],
      ["APN1-EBS:VolumeP-IOPS.piops", "CreateVolume-P-IOPS", 4000],
    ]);
  });

  it("splits io2 IOPS into the three price tiers", () => {
    const r = usage("aws_ebs_volume", { type: "io2", size: 100, iops: 70000 });
    expect(r.lines.map((l) => [l.usageType, l.amount])).toEqual([
      ["APN1-EBS:VolumeUsage.io2", 100],
      ["APN1-EBS:VolumeP-IOPS.io2", 32000],
      ["APN1-EBS:VolumeP-IOPS.io2.tier2", 32000],
      ["APN1-EBS:VolumeP-IOPS.io2.tier3", 6000],
    ]);
  });

  it("maps every volume type to its usage type and operation", () => {
    const pairs = ["gp2", "st1", "sc1", "standard"].map((type) => {
      const l = usage("aws_ebs_volume", { type, size: 1 }, VIRGINIA).lines[0];
      return [type, l?.usageType, l?.operation];
    });
    expect(pairs).toEqual([
      ["gp2", "EBS:VolumeUsage.gp2", "CreateVolume-Gp2"],
      ["st1", "EBS:VolumeUsage.st1", "CreateVolume-St1"],
      ["sc1", "EBS:VolumeUsage.sc1", "CreateVolume-Sc1"],
      ["standard", "EBS:VolumeUsage", "CreateVolume"],
    ]);
  });

  it("reports io1 IOPS that are not known until apply", () => {
    const r = usage("aws_ebs_volume", { type: "io1", size: 100 }, TOKYO, { iops: true });
    expect(r.lines).toHaveLength(1);
    expect(r.partial).toEqual(["volume IOPS is not known until apply"]);
  });

  it("cannot estimate a volume whose size is unknown (for example from a snapshot)", () => {
    const r = usage("aws_ebs_volume", { type: "gp3" }, TOKYO, { size: true });
    expect(r.unestimable).toBeDefined();
  });
});

describe("aws_db_instance", () => {
  it("prices a single-AZ MySQL instance and gp3 storage", () => {
    const r = usage("aws_db_instance", {
      engine: "mysql",
      instance_class: "db.t3.micro",
      multi_az: false,
      allocated_storage: 20,
      storage_type: "gp3",
    });
    expect(r.lines.map((l) => [l.serviceCode, l.usageType, l.operation, l.amount])).toEqual([
      ["AmazonRDS", "APN1-InstanceUsage:db.t3.micro", "CreateDBInstance:0002", 730],
      ["AmazonRDS", "APN1-RDS:GP3-Storage", "CreateDBInstance:0002", 20],
    ]);
  });

  it("prices a Multi-AZ PostgreSQL instance and gp2 storage", () => {
    const r = usage("aws_db_instance", {
      engine: "postgres",
      instance_class: "db.m5.large",
      multi_az: true,
      allocated_storage: 100,
      storage_type: "gp2",
    });
    expect(r.lines.map((l) => [l.usageType, l.operation])).toEqual([
      ["APN1-Multi-AZUsage:db.m5.large", "CreateDBInstance:0014"],
      ["APN1-RDS:Multi-AZ-GP2-Storage", "CreateDBInstance:0014"],
    ]);
  });

  it("knows MariaDB", () => {
    const r = usage("aws_db_instance", {
      engine: "mariadb",
      instance_class: "db.t3.micro",
      allocated_storage: 20,
      storage_type: "gp2",
    });
    expect(r.lines[0]?.operation).toBe("CreateDBInstance:0018");
  });

  it("cannot estimate an engine outside MySQL, PostgreSQL and MariaDB", () => {
    const r = usage("aws_db_instance", { engine: "oracle-ee", instance_class: "db.m5.large" });
    expect(r.unestimable).toContain("oracle-ee");
  });

  it("does not flag gp3 storage left at its baseline performance", () => {
    const r = usage(
      "aws_db_instance",
      {
        engine: "mysql",
        instance_class: "db.t3.micro",
        allocated_storage: 20,
        storage_type: "gp3",
      },
      TOKYO,
      { iops: true, storage_throughput: true },
    );
    expect(r.partial).toEqual([]);
  });

  it("reports storage whose size is not known until apply", () => {
    const r = usage(
      "aws_db_instance",
      { engine: "mysql", instance_class: "db.t3.micro", storage_type: "gp3" },
      TOKYO,
      { allocated_storage: true },
    );
    expect(r.partial).toEqual(["storage size is not known until apply"]);
  });
});

describe("aws_nat_gateway", () => {
  it("prices gateway hours and excludes data processing", () => {
    const r = usage("aws_nat_gateway", { connectivity_type: "public" });
    expect(r.lines[0]).toMatchObject({
      serviceCode: "AmazonEC2",
      usageType: "APN1-NatGateway-Hours",
      operation: "NatGateway",
      amount: 730,
    });
    expect(r.excluded.join(" ")).toContain("data processing");
  });
});

describe("aws_lb", () => {
  it("prices an application load balancer by default", () => {
    const r = usage("aws_lb", {});
    expect(r.lines[0]).toMatchObject({
      serviceCode: "AWSELB",
      usageType: "APN1-LoadBalancerUsage",
      operation: "LoadBalancing:Application",
      amount: 730,
    });
    expect(r.excluded.join(" ")).toContain("LCU");
  });

  it("prices network and gateway load balancers", () => {
    expect(usage("aws_lb", { load_balancer_type: "network" }).lines[0]?.operation).toBe(
      "LoadBalancing:Network",
    );
    expect(usage("aws_lb", { load_balancer_type: "gateway" }).lines[0]?.operation).toBe(
      "LoadBalancing:Gateway",
    );
  });

  it("cannot estimate a load balancer whose type is not known until apply", () => {
    expect(usage("aws_lb", {}, TOKYO, { load_balancer_type: true }).unestimable).toBeDefined();
  });

  it("treats aws_alb as an alias of aws_lb", () => {
    expect(usage("aws_alb", {}).lines[0]?.operation).toBe("LoadBalancing:Application");
  });
});

describe("isAwsType", () => {
  it("recognizes the aws and awscc providers only", () => {
    expect(isAwsType("aws_s3_bucket")).toBe(true);
    expect(isAwsType("awscc_s3_bucket")).toBe(true);
    expect(isAwsType("random_id")).toBe(false);
    expect(isAwsType("awsx_thing")).toBe(false);
  });
});
