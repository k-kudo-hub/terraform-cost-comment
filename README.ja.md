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
- 試算できなかった変更は、黙って捨てずにリソースごとに並べます。合計を全体だと思い込まないためです

## 使う人

インフラのコードをレビューし、その費用の説明も求められるプラットフォームチームやプロダクトリード。

## コメントの例（`language: ja`）

PR の説明に `cost-expectation: +50` と書いたとき:

```markdown
### 💰 月額費用の変化: **+$1,346.60** /月

> [!WARNING]
> 想定した変化（+$50.00/月）より **$1,296.60/月 多く** なります（試算できたリソースについて）。マージの前に、この増加が意図したものかを確かめてください。

> [!CAUTION]
> 1 件の変更がこの合計に含まれていません。実際の変化はこれより大きくなることがあります。

| | 月額 |
|---|---:|
| 変更前 | $0.00 |
| 変更後 | $1,346.60 |
| 想定した変化 | +$50.00 |

#### リソースごとの変化（増加の大きい順）

| リソース | 操作 | 変更前 | 変更後 | 変化 |
|---|---|---:|---:|---:|
| `aws_ebs_volume.data` | 作成 | $0.00 | $768.40 | **+$768.40** |
| `aws_db_instance.db` | 作成 | $0.00 | $421.80 | **+$421.80** |
| `aws_instance.web` | 作成 | $0.00 | $93.40 | **+$93.40** |
| `aws_nat_gateway.main` | 作成 | $0.00 | $45.26 | **+$45.26** |
| `aws_lb.app` | 作成 | $0.00 | $17.74 | **+$17.74** |

#### ⚠️ 試算できなかったもの（1 件）

| リソース | 操作 | 試算できなかったもの |
|---|---|---|
| `aws_s3_bucket.logs` | 作成 | resource type aws_s3_bucket is not supported |
```

実際のコメントには、試算した使用量の内訳・試算に含まれないもの・試算の前提が、折りたたみで続きます。
push のたびに同じコメントを書き換えるので、PR には最新の試算が1つだけ残ります。

## 使い方

```yaml
name: Terraform cost

on:
  pull_request:
    # edited: PR の説明（cost-expectation）を書き換えたときに試算し直す
    types: [opened, synchronize, reopened, edited]

# PR ごとに1つずつ動かし、push と説明の編集が重なってもコメントが2つにならないようにする
concurrency:
  group: terraform-cost-${{ github.event.pull_request.number }}
  cancel-in-progress: true

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

フォークからの PR には読み取り専用のトークンしか渡らず、OIDC のトークンも渡らないため、上のワークフローが動くのは同じリポジトリのブランチからの PR です。
plan に使うロールには読み取りの権限だけを与え、信頼ポリシーをこのリポジトリの PR に絞ってください（`token.actions.githubusercontent.com:sub` を `repo:OWNER/REPO:pull_request` にする）。

### IAM の権限

`terraform plan` に要る権限に加えて、次の1つが必要です。この API は[追加料金なし](https://aws.amazon.com/about-aws/whats-new/2026/11/aws-pricing-calculator-api/)で使えます。

```json
{
  "Effect": "Allow",
  "Action": "bcm-pricing-calculator:GetUsageLinesEstimatedCost",
  "Resource": "*"
}
```

### AWS の権限を絞る

このアクションが呼ぶ AWS の API は `GetUsageLinesEstimatedCost` の1つだけで、ジョブが持つ認証情報をそのまま使います。
アカウント ID も、そのほかのアカウントの情報も読みません。

**料金を調べるロールを分ける。** `terraform plan` には state やリソースを読む広い権限が要りますが、料金を調べるには上の1つの権限で足ります。
このアクションの直前で料金専用のロールに切り替えれば、Pricing Calculator の API を呼ぶステップからは、ほかのものを読めなくなります。

```yaml
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/terraform-plan
          aws-region: ap-northeast-1
      - run: |
          terraform init -input=false
          terraform plan -input=false -out=tfplan
          terraform show -json tfplan > plan.json
      # plan のロールを手放し、GetUsageLinesEstimatedCost だけを呼べるロールに切り替える
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::123456789012:role/terraform-cost-pricing
          aws-region: ap-northeast-1
          unset-current-credentials: true
      - uses: k-kudo-hub/terraform-cost-comment@v0
        with:
          plan-json: plan.json
          language: ja
```

`terraform-cost-pricing` には [IAM の権限](#iam-の権限) のポリシーだけを付け、信頼ポリシーは plan のロールと同じようにこのリポジトリの PR に絞ってください。

**`AFTER_DISCOUNTS` を使う前に考える。** `rate-type` を `AFTER_DISCOUNTS` か `AFTER_DISCOUNTS_AND_COMMITMENTS` にすると、コメントには割引を反映した自社の単価が載ります（後者は Savings Plans とリザーブドインスタンスも反映）。
すると、PR を読める人なら誰でも、自社が AWS と結んでいる割引を推し量れるようになります。
リポジトリを読める人全員にその単価を見せてよい場合を除き、既定の `BEFORE_DISCOUNTS`（公開のオンデマンド料金）のままにしてください。

### 入力

| 名前 | 既定値 | 説明 |
|---|---|---|
| `plan-json` | （必須） | `terraform show -json <planfile>` の出力のパス |
| `aws-region` | 説明を参照 | リソースを作るリージョン。省略すると、plan の `aws` プロバイダーの設定（定数か変数）、次に環境変数 `AWS_REGION` と `AWS_DEFAULT_REGION`（`configure-aws-credentials` が設定する）から読む |
| `rate-type` | `BEFORE_DISCOUNTS` | `BEFORE_DISCOUNTS`（公開のオンデマンド料金）・`AFTER_DISCOUNTS`・`AFTER_DISCOUNTS_AND_COMMITMENTS`。後ろの2つは Pricing Calculator の料金の設定で許可されている必要があり、割引後の自社の単価がコメントに載る（[AWS の権限を絞る](#aws-の権限を絞る)） |
| `language` | `en` | コメントの言語。`en` か `ja` |
| `comment-tag` | （空） | 1つの PR で plan を複数回すとき（例: `prod` と `staging`）に、plan ごとにコメントを分ける |
| `fail-on-unexpected` | `false` | 試算した増加が `cost-expectation` を超えたとき、または想定が書かれていないのに費用が増えたときに、ステップを失敗させる |
| `github-token` | `${{ github.token }}` | コメントに使うトークン。既定のトークンか GitHub App のトークンを使う。このアクションはボットが投稿したコメントだけを書き換えるため、個人のトークンでは毎回新しいコメントになる |

### 出力

| 名前 | 説明 |
|---|---|
| `monthly-delta` | 月額費用の変化の試算（米ドル。下がるときは負の数） |
| `monthly-before` / `monthly-after` | 試算できたリソースの、変更前と変更後の月額 |
| `unexpected` | 試算した増加が想定を超えたとき、または想定が書かれていないのに費用が増えたときに `true` |
| `not-estimated-count` | 合計に含まれなかった変更の数（リソースごと試算できなかったものと、試算できたリソースの一部） |
| `region` | 試算に使ったリージョン |

`unexpected` と `fail-on-unexpected` が判定するのは、試算できた金額だけです。試算できなかった変更があるときに止めたいなら、後のステップで `not-estimated-count` を確かめてください。

PR 以外のイベントでは、ジョブのサマリーにだけ書き出します。

## 試算するもの

| リソース | 試算するもの | 試算しないもの |
|---|---|---|
| `aws_instance` | インスタンスの稼働時間（Linux・オンデマンド・共有テナンシー）、ルートボリュームと追加の EBS ボリューム、`associate_public_ip_address = true` のときのパブリック IPv4 アドレス | Linux 以外の OS のライセンス、サブネットが割り当てるパブリック IPv4 アドレス、データ転送 |
| `aws_ebs_volume` | gp2・gp3・io1・io2・st1・sc1・standard のストレージ、gp3 の無料枠を超える IOPS とスループット、io1 の IOPS、io2 の IOPS（3段階の料金） | スナップショット |
| `aws_db_instance` | MySQL・PostgreSQL・MariaDB のインスタンスの稼働時間（シングル AZ とマルチ AZ）、gp2・gp3・io1・io2・マグネティックのストレージ、io1 と io2 のプロビジョンド IOPS | gp3 の基準を超える性能（「試算できなかったもの」に並ぶ）、バックアップのストレージ、データ転送 |
| `aws_rds_cluster_instance` | Aurora MySQL と Aurora PostgreSQL のインスタンスの稼働時間（クラスターに合わせて Standard か I/O-Optimized の単価） | Aurora Serverless v2（「試算できなかったもの」に並ぶ） |
| `aws_rds_cluster` | Aurora ではなし（インスタンスは `aws_rds_cluster_instance` として試算する） | Aurora のストレージと I/O、バックアップのストレージ、マルチ AZ DB クラスター（Aurora 以外。「試算できなかったもの」に並ぶ） |
| `aws_elasticache_cluster` | Redis・Valkey・Memcached のノードの稼働時間 | `replication_group_id` でレプリケーショングループに足すリードレプリカ（「試算できなかったもの」に並ぶ）、バックアップのストレージ、データ転送 |
| `aws_elasticache_replication_group` | すべてのノードの稼働時間（`num_cache_clusters`、またはシャード数 ×（レプリカ数 + 1）） | バックアップのストレージ、データ転送 |
| `aws_eks_cluster` | クラスターの稼働時間 | 延長サポートの追加料金、ワーカーノード（それぞれのリソースとして試算する） |
| `aws_opensearch_domain` / `aws_elasticsearch_domain` | データノードと専用マスターノードの稼働時間、データノードごとの gp2・gp3・io1・マグネティックのストレージ、io1 の IOPS | UltraWarm ノードと gp3 の基準を超える性能（「試算できなかったもの」に並ぶ）、スナップショット、データ転送 |
| `aws_nat_gateway` | ゲートウェイの稼働時間 | データ処理量（GB 単位） |
| `aws_eip` | パブリック IPv4 アドレスの時間 | |
| `aws_vpc_endpoint` | インターフェイス型エンドポイントのサブネットごとの稼働時間、Gateway Load Balancer 型エンドポイントの稼働時間（ゲートウェイ型は時間料金なし） | データ処理量（GB 単位） |
| `aws_lb` / `aws_alb` | Application・Network・Gateway の各ロードバランサーの稼働時間 | キャパシティユニット（LCU） |

稼働し続けるリソースは、AWS Pricing Calculator と同じく月730時間として試算します。料金は米ドル・税抜きです。
対応リージョンは AWS の商用リージョンすべてで、GovCloud (US) と中国のリージョンは Pricing Calculator API が対応していません。

設定に書かれていない属性には既定値を使います。EBS ボリュームは gp2（EC2 の API）、RDS のストレージは `iops` があれば io1、なければ gp3（RDS の API）、レプリケーショングループは1シャード（ElastiCache の API）・1ノード（プロバイダーの文書）・Redis（プロバイダーの実装）です。
RDS の API にはマルチ AZ の既定値が書かれていないため、`multi_az` のないインスタンスはシングル AZ として試算し、そう仮定したことをコメントに書きます。

次のものは、リソースと理由をつけて「試算できなかったもの」に並びます。

- 対応していない種類の AWS リソース
- 料金を決める値のうち、apply するまで分からないもの（ほかのリソースから受け取るインスタンスタイプ、AMI で決まるルートボリュームのサイズ）
- 対応しているリソースのうち、試算できない部分（UltraWarm ノード）
- クラスターのストレージの種類を読めない Aurora のインスタンス（クラスターが plan にない、またはストレージの種類が apply まで分からないとき。Standard の単価で試算し、I/O-Optimized のクラスターなら高くなることを書く）
- AWS が料金を返さなかった使用量

使用量で決まる料金（データ転送・LCU・NAT のデータ処理）は plan から読めないため、コメントの注記に名前だけを書きます。
AWS 以外のプロバイダーのリソース（例: `random_id`、`null_resource`）は AWS の費用がかからないため、注記で件数だけを示します。

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
