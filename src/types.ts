/** One line of usage to price with GetUsageLinesEstimatedCost. */
export interface UsageLine {
  serviceCode: string;
  usageType: string;
  operation: string;
  /** Monthly amount in the usage type's unit (hours, GB-Mo, IOPS-Mo ...). */
  amount: number;
  /** Human readable description of the line, e.g. "t3.micro (730 h)". */
  description: string;
}

/** Result of turning one resource's attributes into usage lines. */
export interface UsageResult {
  lines: UsageLine[];
  /** Parts of the resource that were not estimated, e.g. "data processing (per GB)". */
  excluded: string[];
  /** Set when the resource could not be estimated at all. */
  unestimable?: string;
}

export type Attributes = Record<string, unknown>;
