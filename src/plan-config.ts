import type { Attributes } from "./types.js";

/** A resource block in `configuration` of `terraform show -json`. */
export interface ConfigResource {
  address: string;
  expressions?: Record<string, { constant_value?: unknown; references?: string[] } | unknown>;
}

export interface ConfigModule {
  resources?: ConfigResource[];
  module_calls?: Record<string, { module?: ConfigModule }>;
}

/** The parts of a resource change that the Aurora lookup reads. */
interface Change {
  address: string;
  type: string;
  change: {
    before?: Attributes | null;
    after?: Attributes | null;
    after_unknown?: Attributes | null;
  };
}

/**
 * Splits "module.a.module.b.aws_x.name[0]" into the module path ["a", "b"] and the address in the
 * module without the instance key, "aws_x.name".
 */
export function splitAddress(address: string): { modules: string[]; local: string } {
  const parts = address.match(/(?:[^.["]+|\[[^\]]*\]|"[^"]*")+/g) ?? [];
  const modules: string[] = [];
  let i = 0;
  while (parts[i] === "module" && parts[i + 1] !== undefined) {
    modules.push((parts[i + 1] ?? "").replace(/\[.*\]$/, ""));
    i += 2;
  }
  const local = parts
    .slice(i)
    .join(".")
    .replace(/\[[^\]]*\]$/, "");
  return { modules, local };
}

/** Finds the configuration block of a resource change's address. */
export function configResource(
  root: ConfigModule | undefined,
  address: string,
): ConfigResource | undefined {
  const { modules, local } = splitAddress(address);
  let mod = root;
  for (const name of modules) mod = mod?.module_calls?.[name]?.module;
  return mod?.resources?.find((r) => r.address === local);
}

function expression(
  block: ConfigResource | undefined,
  key: string,
): { constant_value?: unknown; references?: string[] } | undefined {
  const e = block?.expressions?.[key];
  return typeof e === "object" && e !== null ? (e as { references?: string[] }) : undefined;
}

/** storage_type of a cluster change, reading the configuration when the plan does not know it. */
function clusterStorage(cluster: Change, root: ConfigModule | undefined): string | undefined {
  const after = cluster.change.after ?? cluster.change.before ?? {};
  const unknown = cluster.change.after_unknown ?? {};
  if (unknown.storage_type !== true) {
    const v = after.storage_type;
    if (v === undefined || v === null || v === "" || v === "aurora") return "aurora";
    return typeof v === "string" ? v : undefined;
  }
  // Known only after apply: left out of the configuration it defaults to Aurora Standard.
  const config = configResource(root, cluster.address);
  if (config === undefined) return undefined;
  const e = expression(config, "storage_type");
  if (e === undefined) return "aurora";
  return typeof e.constant_value === "string" ? e.constant_value || "aurora" : undefined;
}

/**
 * The storage type of the Aurora cluster an aws_rds_cluster_instance belongs to, or undefined
 * when the cluster cannot be found in the plan.
 */
export function auroraStorageType(
  instance: Change,
  changes: readonly Change[],
  root: ConfigModule | undefined,
): string | undefined {
  const clusters = changes.filter((c) => c.type === "aws_rds_cluster");
  const attrs = instance.change.after ?? instance.change.before ?? {};
  const id = attrs.cluster_identifier;
  if (typeof id === "string" && id !== "") {
    const match = clusters.find(
      (c) => (c.change.after ?? c.change.before)?.cluster_identifier === id,
    );
    return match === undefined ? undefined : clusterStorage(match, root);
  }
  const refs = expression(configResource(root, instance.address), "cluster_identifier")?.references;
  const ref = refs?.find((r) => r.startsWith("aws_rds_cluster."));
  if (ref === undefined) return undefined;
  const target = ref.split(".").slice(0, 2).join(".").replace(/\[.*$/, "");
  const { modules } = splitAddress(instance.address);
  const candidates = clusters.filter((c) => {
    const s = splitAddress(c.address);
    return s.local === target && s.modules.join(".") === modules.join(".");
  });
  const types = new Set(candidates.map((c) => clusterStorage(c, root)));
  return types.size === 1 ? [...types][0] : undefined;
}
