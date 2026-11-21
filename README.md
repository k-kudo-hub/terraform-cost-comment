# Terraform Cost Comment

[日本語](README.ja.md)

A GitHub Action that comments on a pull request how a Terraform plan changes the monthly AWS cost,
priced by AWS's own [Pricing Calculator API](https://docs.aws.amazon.com/cli/latest/reference/bcm-pricing-calculator/get-usage-lines-estimated-cost.html).

## Why

Whoever opens a pull request that changes infrastructure usually expects *some* cost increase.
The loss comes from the increase nobody expected: an IOPS figure with one zero too many, a NAT gateway
in every subnet, an instance class two sizes up. This action is built to catch those before merge.

- The PR author writes the change they expect in the PR description (`cost-expectation: +50`).
  The comment says whether the estimate stays within it, and by how much it exceeds it.
- When cost goes up and no expectation is written, the comment asks whether the increase is expected.
- Changes the action cannot price are listed by resource, never silently dropped, so the total is
  not mistaken for the whole picture.

## Who it is for

Platform teams and product leads who review infrastructure code and are asked to explain its cost.

## What the comment looks like

With `cost-expectation: +50` in the PR description:

```markdown
### 💰 Monthly cost change: **+$1,346.60** /mo

> [!WARNING]
> This is **$1,296.60/mo more** than the expected change (+$50.00/mo) for the estimated resources. Check that the increase is intended before merging.

> [!CAUTION]
> 1 change is not included in this total. The real change can be larger.

| | Monthly |
|---|---:|
| Before | $0.00 |
| After | $1,346.60 |
| Expected change | +$50.00 |

#### Changes by resource (largest increase first)

| Resource | Action | Before | After | Change |
|---|---|---:|---:|---:|
| `aws_ebs_volume.data` | create | $0.00 | $768.40 | **+$768.40** |
| `aws_db_instance.db` | create | $0.00 | $421.80 | **+$421.80** |
| `aws_instance.web` | create | $0.00 | $93.40 | **+$93.40** |
| `aws_nat_gateway.main` | create | $0.00 | $45.26 | **+$45.26** |
| `aws_lb.app` | create | $0.00 | $17.74 | **+$17.74** |

#### ⚠️ Not estimated (1)

| Resource | Action | What is missing |
|---|---|---|
| `aws_s3_bucket.logs` | create | resource type aws_s3_bucket is not supported |
```

The real comment also has collapsible sections with the priced usage lines, what the estimate leaves
out, and its assumptions. Each push updates the same comment, so the PR keeps one current estimate.

## Usage

```yaml
name: Terraform cost

on:
  pull_request:
    # "edited" re-runs the estimate when the PR description (cost-expectation) changes.
    types: [opened, synchronize, reopened, edited]

# One run per PR at a time, so quick pushes and edits do not post two comments.
concurrency:
  group: terraform-cost-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  id-token: write       # for OIDC with configure-aws-credentials
  pull-requests: write  # to comment on the PR

jobs:
  cost:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false  # keep `terraform show -json` output clean
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/terraform-plan
          aws-region: ap-northeast-1
      - run: |
          terraform init -input=false
          terraform plan -input=false -out=tfplan
          terraform show -json tfplan > plan.json
      - uses: k-kudo-hub/terraform-cost-comment@v0
        with:
          plan-json: plan.json
```

Then write the change you expect in the PR description, on its own line:

```text
cost-expectation: +50
```

The figure is USD per month. Use a negative figure (`cost-expectation: -20`) when the PR should save money.

Pull requests from forks get a read-only token and no OIDC token, so the workflow above works for pull
requests from branches of the same repository. Give the plan role read-only permissions, and limit its
trust policy to pull requests of your repository (`token.actions.githubusercontent.com:sub` =
`repo:OWNER/REPO:pull_request`).

### IAM permission

The role needs one action in addition to what `terraform plan` needs. The API is
[free of charge](https://aws.amazon.com/about-aws/whats-new/2026/11/aws-pricing-calculator-api/).

```json
{
  "Effect": "Allow",
  "Action": "bcm-pricing-calculator:GetUsageLinesEstimatedCost",
  "Resource": "*"
}
```

### Inputs

| Name | Default | Description |
|---|---|---|
| `plan-json` | (required) | Path to the output of `terraform show -json <planfile>`. |
| `aws-region` | see description | Region the resources are created in. When omitted: the `aws` provider block in the plan (a constant or a variable), then the `AWS_REGION` and `AWS_DEFAULT_REGION` environment variables, which `configure-aws-credentials` sets. |
| `rate-type` | `BEFORE_DISCOUNTS` | `BEFORE_DISCOUNTS` (public on-demand prices), `AFTER_DISCOUNTS`, or `AFTER_DISCOUNTS_AND_COMMITMENTS`. The last two must be allowed by your Pricing Calculator rate preferences. |
| `language` | `en` | Language of the comment: `en` or `ja`. |
| `comment-tag` | (empty) | Keeps a separate comment per plan when one PR runs several plans, for example `prod` and `staging`. |
| `fail-on-unexpected` | `false` | Fail the step when the estimated increase exceeds `cost-expectation`, or when cost goes up and no expectation is written. |
| `github-token` | `${{ github.token }}` | Token used to comment. Use the default token or a GitHub App token: the action updates only comments posted by a bot, so with a personal token it posts a new comment on every run. |

### Outputs

| Name | Description |
|---|---|
| `monthly-delta` | Estimated change of the monthly cost in USD (negative when cost goes down). |
| `monthly-before` / `monthly-after` | Estimated monthly cost of the estimated resources before and after the change. |
| `unexpected` | `true` when the estimated increase exceeds the expectation, or cost goes up with no expectation written. |
| `not-estimated-count` | Number of changes left out of the total: whole resources, and parts of estimated resources. |
| `region` | Region used for pricing. |

`unexpected` and `fail-on-unexpected` judge the estimated amount only. To stop on changes the action
cannot price, check `not-estimated-count` in a later step.

Outside pull requests the action writes the estimate to the job summary only.

## What it estimates

| Resource | Priced | Not priced |
|---|---|---|
| `aws_instance` | Instance hours (Linux, on-demand, default tenancy), root and extra EBS volumes, a public IPv4 address when `associate_public_ip_address = true` | OS licenses other than Linux, data transfer |
| `aws_ebs_volume` | Storage of gp2, gp3, io1, io2, st1, sc1, standard; gp3 IOPS and throughput above the free baseline; io1 IOPS; io2 IOPS in its three price tiers | Snapshots |
| `aws_db_instance` | Instance hours for MySQL, PostgreSQL, MariaDB (Single-AZ and Multi-AZ); gp2, gp3, io1, io2, magnetic storage; io1 and io2 provisioned IOPS | gp3 performance above the baseline (listed as not estimated), backup storage, data transfer |
| `aws_rds_cluster_instance` | Aurora MySQL and Aurora PostgreSQL instance hours, at the Standard or I/O-Optimized rate of the cluster | Aurora Serverless v2 (listed as not estimated) |
| `aws_rds_cluster` | Nothing: its instances are priced as `aws_rds_cluster_instance` | Aurora storage and I/O, backup storage |
| `aws_elasticache_cluster` | Node hours for Redis, Valkey and Memcached (a member of a replication group is priced with the group) | Backup storage, data transfer |
| `aws_elasticache_replication_group` | Node hours for every node (`num_cache_clusters`, or shards × (replicas + 1)) | Backup storage, data transfer |
| `aws_eks_cluster` | Cluster hours | Extended support surcharge, worker nodes (priced as their own resources) |
| `aws_opensearch_domain` / `aws_elasticsearch_domain` | Data node and dedicated master node hours; gp2, gp3, io1, magnetic storage for every data node; io1 IOPS | UltraWarm nodes and gp3 performance above the baseline (listed as not estimated), snapshots, data transfer |
| `aws_nat_gateway` | Gateway hours | Data processing per GB |
| `aws_eip` | Public IPv4 address hours | |
| `aws_vpc_endpoint` | Interface endpoint hours per subnet, Gateway Load Balancer endpoint hours (gateway endpoints have no hourly charge) | Data processing per GB |
| `aws_lb` / `aws_alb` | Application, network and gateway load balancer hours | Capacity units (LCU) |

Running resources are priced for 730 hours a month, the figure AWS Pricing Calculator uses.
Prices are in USD before tax. Supported regions are all commercial AWS Regions; GovCloud (US) and China
Regions are not supported by the Pricing Calculator API.

An attribute left out of the configuration takes its default: an EBS volume is gp2 (EC2 API), RDS
storage is io1 when `iops` is set and gp3 otherwise (RDS API), a replication group is one Redis node
(provider documentation). The RDS API states no default for Multi-AZ, so an instance without `multi_az`
is priced as Single-AZ and the comment says so.

These are listed under **Not estimated**, with the resource and the reason:

- AWS resources of a type the action does not support
- Values that decide the price but are known only after apply, such as an instance type taken from
  another resource, or a root volume whose size comes from the AMI
- Parts of a supported resource the action cannot price, such as UltraWarm nodes
- An Aurora instance whose cluster is not in the plan: it is priced at the Standard rate, and the
  comment notes that an I/O-Optimized cluster costs more
- Usage AWS returns no price for

Charges that depend on usage (data transfer, LCU, NAT data processing) cannot be read from a plan.
They are named in the comment's footnote instead. Resources of other providers, such as `random_id` or
`null_resource`, cost nothing on AWS and are only counted in the footnote.

## How it compares with Infracost

[Infracost](https://github.com/infracost/infracost) covers far more resources and clouds. This action
does one thing differently: prices come from AWS's own API with your AWS credentials, so no third-party
API key is needed, and with `AFTER_DISCOUNTS` the estimate can reflect your account's discounts.
It is also built around the PR author's expectation rather than the total alone.

## Development

```sh
npm ci
npm run all              # typecheck, lint, test, bundle into dist/
npm run verify:pricing   # needs AWS credentials: checks every usage line is priced in every region
```

`dist/index.js` is committed because GitHub runs it directly. CI fails when it does not match the source.

## License

MIT
