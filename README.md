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
- Resources the action cannot price are listed, never silently dropped, so the total is not mistaken
  for the whole picture.

## Who it is for

Platform teams and product leads who review infrastructure code and are asked to explain its cost.

## What the comment looks like

```markdown
### 💰 Monthly cost change: **+$1,346.60** /mo

> [!WARNING]
> This is **$1,296.60/mo more** than the expected change (+$50.00/mo). Check that the increase is intended before merging.

> ⚠️ 1 changed resource is not included in this total. The real change can be larger.

| Resource | Action | Before | After | Change |
|---|---|---:|---:|---:|
| `aws_ebs_volume.data` | create | $0.00 | $768.40 | **+$768.40** |
| `aws_db_instance.db` | create | $0.00 | $421.80 | **+$421.80** |
| `aws_instance.web` | create | $0.00 | $93.40 | **+$93.40** |
| `aws_nat_gateway.main` | create | $0.00 | $45.26 | **+$45.26** |
| `aws_lb.app` | create | $0.00 | $17.74 | **+$17.74** |

#### ⚠️ Not estimated (1)

| Resource | Action | Why |
|---|---|---|
| `aws_s3_bucket.logs` | create | resource type aws_s3_bucket is not supported |
```

Each push updates the same comment, so the PR keeps one current estimate. The full comment also lists
the priced usage lines, what the estimate leaves out, and its assumptions.

## Usage

```yaml
name: Terraform cost

on:
  pull_request:
    # "edited" re-runs the estimate when the PR description (cost-expectation) changes.
    types: [opened, synchronize, reopened, edited]

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
| `aws-region` | read from the plan | Region the resources are created in. Read from the `aws` provider block (a constant or a variable) when omitted. |
| `rate-type` | `BEFORE_DISCOUNTS` | `BEFORE_DISCOUNTS` (public on-demand prices), `AFTER_DISCOUNTS`, or `AFTER_DISCOUNTS_AND_COMMITMENTS`. The last two must be allowed by your Pricing Calculator rate preferences. |
| `language` | `en` | Language of the comment: `en` or `ja`. |
| `comment-tag` | (empty) | Keeps a separate comment per plan when one PR runs several plans, for example `prod` and `staging`. |
| `fail-on-unexpected` | `false` | Fail the step when the increase exceeds `cost-expectation`, or when cost goes up and no expectation is written. |
| `github-token` | `${{ github.token }}` | Token used to comment. |

### Outputs

| Name | Description |
|---|---|
| `monthly-delta` | Estimated change of the monthly cost in USD (negative when cost goes down). |
| `monthly-before` / `monthly-after` | Estimated monthly cost of the estimated resources before and after the change. |
| `unexpected` | `true` when the increase exceeds the expectation, or cost goes up with no expectation written. |
| `not-estimated-count` | Number of changed resources left out of the estimate. |
| `region` | Region used for pricing. |

Outside pull requests the action writes the estimate to the job summary only.

## What it estimates

| Resource | Priced | Left out |
|---|---|---|
| `aws_instance` | Instance hours (Linux, on-demand, default tenancy), root and extra EBS volumes whose size and type are known at plan time | OS licenses other than Linux, data transfer |
| `aws_ebs_volume` | Storage of gp2, gp3, io1, io2, st1, sc1, standard; gp3 IOPS and throughput above the free baseline; io1 IOPS; io2 IOPS in its three price tiers | Snapshots |
| `aws_db_instance` | Instance hours for MySQL, PostgreSQL, MariaDB (Single-AZ and Multi-AZ); gp2, gp3, magnetic storage | Provisioned IOPS storage (io1/io2), gp3 IOPS and throughput above the baseline, backup storage, data transfer |
| `aws_nat_gateway` | Gateway hours | Data processing per GB |
| `aws_lb` / `aws_alb` | Application, network and gateway load balancer hours | Capacity units (LCU) |

Running resources are priced for 730 hours a month, the figure AWS Pricing Calculator uses.
Prices are in USD before tax. Supported regions are all commercial AWS Regions; GovCloud (US) and China
Regions are not supported by the Pricing Calculator API.

A changed resource is listed under **Not estimated** when its type is not supported, when a value that
decides its price (such as the instance type) is only known after apply, or when AWS returns no price
for its usage.

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
