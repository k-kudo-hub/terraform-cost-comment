# Terraform Cost Comment

[English](README.md)

Terraform の plan で AWS の月額費用がどう変わるかを、AWS 公式の [Pricing Calculator API](https://docs.aws.amazon.com/cli/latest/reference/bcm-pricing-calculator/get-usage-lines-estimated-cost.html) で試算し、
プルリクエストにコメントする GitHub Action です。

## なぜ作ったか

インフラを変える PR を出す人は、ふつう、ある程度の費用の増加を想定しています。
損失を生むのは、誰も想定していなかった増加です。IOPS の桁を1つ多く書いた、NAT ゲートウェイをサブネットごとに置いた、インスタンスクラスを2段上げた。
このアクションは、そうした想定外の支出をマージの前に見つけるために作りました。

- PR の作成者は、想定する費用の変化を PR の説明に書きます（`cost-expectation: +50`）。コメントは、試算がその範囲に収まるか、どれだけ超えるかを示します
- 費用が増えるのに想定が書かれていなければ、コメントはその増加が想定どおりかを問います
- 試算できなかったリソースは黙って捨てずに一覧にします。合計を全体だと思い込まないためです

## 使う人

インフラのコードをレビューし、その費用の説明も求められるプラットフォームチームやプロダクトリード。

## コメントの例（`language: ja`）

```markdown
### 💰 月額費用の変化: **+$1,346.60** /月

> [!WARNING]
> 想定した変化（+$50.00/月）より **$1,296.60/月 多く** なります。マージの前に、この増加が意図したものかを確かめてください。

> ⚠️ 変更されるリソースのうち 1 件は、この合計に含まれていません。実際の変化はこれより大きくなることがあります。

| リソース | 操作 | 変更前 | 変更後 | 変化 |
|---|---|---:|---:|---:|
| `aws_ebs_volume.data` | 作成 | $0.00 | $768.40 | **+$768.40** |
| `aws_db_instance.db` | 作成 | $0.00 | $421.80 | **+$421.80** |
| `aws_instance.web` | 作成 | $0.00 | $93.40 | **+$93.40** |
| `aws_nat_gateway.main` | 作成 | $0.00 | $45.26 | **+$45.26** |
| `aws_lb.app` | 作成 | $0.00 | $17.74 | **+$17.74** |

#### ⚠️ 試算できなかったリソース（1 件）

| リソース | 操作 | 理由 |
|---|---|---|
| `aws_s3_bucket.logs` | 作成 | resource type aws_s3_bucket is not supported |
```

push のたびに同じコメントを書き換えるので、PR には最新の試算が1つだけ残ります。
コメントの全文には、試算した使用量の内訳・試算に含めていないもの・試算の前提も載ります。

## 使い方

```yaml
name: Terraform cost

on:
  pull_request:
    # edited: PR の説明（cost-expectation）を書き換えたときに試算し直す
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read
  id-token: write       # configure-aws-credentials で OIDC を使うため
  pull-requests: write  # PR にコメントするため

jobs:
  cost:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_wrapper: false  # terraform show -json の出力をそのまま使うため
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
          language: ja
```

PR の説明には、想定する変化を1行で書きます。

```text
cost-expectation: +50
```

単位は米ドル／月です。費用を下げる PR なら負の数（`cost-expectation: -20`）を書きます。

### IAM の権限

`terraform plan` に要る権限に加えて、次の1つが必要です。この API は[追加料金なし](https://aws.amazon.com/about-aws/whats-new/2026/11/aws-pricing-calculator-api/)で使えます。

```json
{
  "Effect": "Allow",
  "Action": "bcm-pricing-calculator:GetUsageLinesEstimatedCost",
  "Resource": "*"
}
```

### 入力

| 名前 | 既定値 | 説明 |
|---|---|---|
| `plan-json` | （必須） | `terraform show -json <planfile>` の出力のパス |
| `aws-region` | plan から読む | リソースを作るリージョン。省略すると `aws` プロバイダーの設定（定数か変数）から読む |
| `rate-type` | `BEFORE_DISCOUNTS` | `BEFORE_DISCOUNTS`（公開のオンデマンド料金）・`AFTER_DISCOUNTS`・`AFTER_DISCOUNTS_AND_COMMITMENTS`。後ろの2つは Pricing Calculator の料金の設定で許可されている必要がある |
| `language` | `en` | コメントの言語。`en` か `ja` |
| `comment-tag` | （空） | 1つの PR で plan を複数回すとき（`prod` と `staging` など）に、plan ごとにコメントを分ける |
| `fail-on-unexpected` | `false` | 増加が `cost-expectation` を超えたとき、または想定が書かれていないのに費用が増えたときに、ステップを失敗させる |
| `github-token` | `${{ github.token }}` | コメントに使うトークン |

### 出力

| 名前 | 説明 |
|---|---|
| `monthly-delta` | 月額費用の変化の試算（米ドル。下がるときは負の数） |
| `monthly-before` / `monthly-after` | 試算できたリソースの、変更前と変更後の月額 |
| `unexpected` | 増加が想定を超えたとき、または想定が書かれていないのに費用が増えたときに `true` |
| `not-estimated-count` | 変更されるリソースのうち、試算に含めなかったものの数 |
| `region` | 試算に使ったリージョン |

PR 以外のイベントでは、ジョブのサマリーにだけ書き出します。

## 試算するもの

| リソース | 試算するもの | 含めないもの |
|---|---|---|
| `aws_instance` | インスタンスの稼働時間（Linux・オンデマンド・共有テナンシー）、plan の時点でサイズと種類が分かるルートボリュームと追加の EBS ボリューム | Linux 以外の OS のライセンス、データ転送 |
| `aws_ebs_volume` | gp2・gp3・io1・io2・st1・sc1・standard のストレージ、gp3 の無料枠を超える IOPS とスループット、io1 の IOPS、io2 の IOPS（3段階の料金） | スナップショット |
| `aws_db_instance` | MySQL・PostgreSQL・MariaDB のインスタンスの稼働時間（シングル AZ とマルチ AZ）、gp2・gp3・マグネティックのストレージ | プロビジョンド IOPS のストレージ（io1・io2）、gp3 の基準を超える IOPS とスループット、バックアップのストレージ、データ転送 |
| `aws_nat_gateway` | ゲートウェイの稼働時間 | データ処理量（GB 単位） |
| `aws_lb` / `aws_alb` | Application・Network・Gateway の各ロードバランサーの稼働時間 | キャパシティユニット（LCU） |

稼働し続けるリソースは、AWS Pricing Calculator と同じく月730時間として試算します。料金は米ドル・税抜きです。
対応リージョンは AWS の商用リージョンすべてで、GovCloud (US) と中国のリージョンは Pricing Calculator API が対応していません。

次のどれかに当たる変更は、「試算できなかったリソース」に並びます。

- リソースの種類に対応していない
- 料金を決める値（インスタンスタイプなど）が apply するまで分からない
- AWS がその使用量の料金を返さなかった

## Infracost との違い

[Infracost](https://github.com/infracost/infracost) は、はるかに多くのリソースとクラウドに対応しています。
このアクションが違うのは、料金を AWS 公式の API から自分の AWS 認証情報で取るため第三者の API キーが要らないことと、`AFTER_DISCOUNTS` を使えば自分のアカウントの割引を反映できることです。
また、合計額だけでなく、PR の作成者の想定と比べることを軸にしています。

## 開発

```sh
npm ci
npm run all              # 型チェック・Lint・テスト・dist/ へのバンドル
npm run verify:pricing   # AWS の認証情報が必要。作る使用量行すべてに全リージョンで料金が付くかを確かめる
```

GitHub は `dist/index.js` をそのまま実行するため、コミットしています。ソースと一致しないと CI が失敗します。

## ライセンス

MIT
