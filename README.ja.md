# shinobidb

[![CI](https://github.com/shinobidb/shinobidb/actions/workflows/ci.yml/badge.svg)](https://github.com/shinobidb/shinobidb/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/shinobidb.svg)](https://www.npmjs.com/package/shinobidb)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![npm downloads](https://img.shields.io/npm/dm/shinobidb.svg)](https://www.npmjs.com/package/shinobidb)

[English](README.md)

本番データベースのデータをマスキングしてステージング環境に同期するCLIツール。DBスキーマからPIIカラムを自動検出し、マスキング設定を生成し、個人情報を匿名化してコピーします。

## 動作要件

- Node.js >= 18
- MySQL 8.0+ / PostgreSQL 14+ / MongoDB 5.0+

## インストール

```bash
npm install -g shinobidb
```

npx で直接実行も可能:

```bash
npx shinobidb --help
```

## クイックスタート

### MySQL

```bash
# 1. ソースDBをスキャンしてPIIカラムを検出
shinobidb scan --host localhost --port 3306 --user root --password secret --schemas mydb

# 2. スキャン結果からマスキング設定を生成
shinobidb config --host localhost --port 3306 --user root --password secret --schemas mydb -o shinobidb.yaml

# 3. shinobidb.yaml を編集 — ターゲット接続先を設定
#    生成ファイルの <TARGET_HOST>, <TARGET_PASSWORD> 等のプレースホルダーを実際の値に置換

# 4. 同期: ダンプ → マスク → アトミックスワップ（パスワードを省略すると対話プロンプトで入力）
shinobidb sync --source-password secret --target-password secret
```

### PostgreSQL

```bash
shinobidb scan --type postgres --host localhost --port 5432 --user admin --database mydb --schemas public
shinobidb config --type postgres --host localhost --port 5432 --user admin --database mydb --schemas public -o shinobidb.yaml
# shinobidb.yaml を編集後:
shinobidb sync --source-password secret --target-password secret
```

### MongoDB

```bash
shinobidb scan --type mongodb --host localhost --port 27017 --user admin --database mydb
shinobidb config --type mongodb --host localhost --port 27017 --user admin --database mydb -o shinobidb.yaml
# shinobidb.yaml を編集後:
shinobidb sync --source-password secret --target-password secret
```

> **Note:** `--type` のデフォルトは `mysql` です。PostgreSQL/MongoDBの場合は必ず `--type` を指定してください。

## CLIコマンド

### 接続オプション

DB接続が必要なコマンドは、個別フラグ、接続URI、または環境変数で指定可能:

```bash
# 個別フラグ
shinobidb scan --host localhost --port 3306 --user root --password secret --schemas mydb

# 接続URI（MySQL, PostgreSQL, MongoDB）
shinobidb scan --uri mysql://root:secret@localhost:3306/mydb
shinobidb scan --uri postgres://user:pass@localhost:5432/mydb
shinobidb scan --uri mongodb://user:pass@localhost:27017/mydb

# 環境変数（CI/CD・本番環境推奨）
export SHINOBIDB_SOURCE_HOST=localhost
export SHINOBIDB_SOURCE_PORT=3306
export SHINOBIDB_SOURCE_USER=root
export SHINOBIDB_SOURCE_PASSWORD=secret
export SHINOBIDB_SOURCE_DATABASE=mydb
export SHINOBIDB_SOURCE_TYPE=mysql    # mysql, postgres, mongodb
shinobidb scan --schemas mydb
```

`mask`コマンドのターゲット接続には `SHINOBIDB_TARGET_*` プレフィックスを使用（キーは同一: `HOST`, `PORT`, `USER`, `PASSWORD`, `DATABASE`, `TYPE`, `URI`）。

**パスワード解決の優先順位:** CLIフラグ > 環境変数 > 設定ファイル > 対話プロンプト。パスワードを省略すると対話的に入力を求められます。

> **セキュリティ:** 本番環境では `--password` 等のCLIフラグでパスワードを渡すことを避けてください（`ps`コマンドで他のプロセスから見えます）。環境変数または対話プロンプトを推奨します。

### `shinobidb scan`

DBに接続してスキーマを読み取り、カラム名パターンからPIIカラムを検出します。

```bash
shinobidb scan \
  --host <host> --port <port> --user <user> --password <password> \
  [--uri <uri>] \
  [--type mysql|postgres|mongodb] [--database <db>] [--schemas <s1,s2>] [--tables <t1,t2>] \
  [--sample-content] [--json]
```

**`--database` と `--schemas` の使い分け:**

- **MySQL** — `--schemas` でスキャン対象のデータベースを指定（MySQLではスキーマ＝データベース）。`--database` は省略可。
- **PostgreSQL** — `--database` で接続先データベースを指定、`--schemas` でスキーマ名を指定（例: `public`）。
- **MongoDB** — `--database` でデータベースを指定。`--schemas` は不要。

`--sample-content` を指定すると、実データのサンプルからもPIIを検出します（メール、電話番号、IPアドレス、クレジットカード番号、SSN）。カラム名検出とコンテンツ検出の両方がヒットした場合、信頼度の高い方が採用されます。

### `shinobidb config`

スキャンを実行し、マスキングルールが事前設定された `shinobidb.yaml` を生成します。

```bash
shinobidb config \
  --host <host> --port <port> --user <user> --password <password> \
  [--uri <uri>] \
  [--type mysql|postgres|mongodb] [--database <db>] [--schemas <s1,s2>] [--tables <t1,t2>] \
  [--sample-content] [--min-confidence <0.0-1.0>] [-o <file>]
```

### `shinobidb sync`

**（推奨）** ネイティブダンプ → UPDATEマスク → アトミックスワップ。`mask`より高速・安全・シンプル。

```bash
shinobidb sync \
  [-c <config-file>] \
  --source-password <password> --target-password <password> \
  [--dry-run] [--keep-old] [--keep-dump <path>] [--input-dump <path>] \
  [--concurrency <n>] [--no-progress] \
  [--audit-log <file>] [--json]
```

動作フロー:

1. **ダンプ** — `mysqldump` / `pg_dump` / `mongodump` でソースDBの完全コピーを作成
2. **リストア** — ダンプをターゲットサーバー上の一時DBにリストア
3. **マスク** — 一時DBでPIIカラムを `UPDATE` 文でマスキング
4. **スワップ** — アトミックスワップ: 一時DB → ターゲット、ターゲット → 旧DB（ダウンタイムゼロ）
5. **クリーンアップ** — 旧DBを削除（`--keep-old` 指定時は保持）

| オプション            | 説明                                                                         |
| --------------------- | ---------------------------------------------------------------------------- |
| `--dry-run`           | ダンプ・リストア・マスクまで実行し、スワップはスキップ。一時DBは検証用に保持 |
| `--keep-old`          | スワップ後に旧DBを保持（手動ロールバック用）                                 |
| `--keep-dump <path>`  | ダンプファイルを指定パスに保存                                               |
| `--input-dump <path>` | ソースからダンプせず、既存のダンプファイルからリストア                       |
| `--concurrency <n>`   | 並列マスキングするテーブル数（デフォルト: 1）                                |
| `--no-progress`       | プログレスバーを無効化                                                       |
| `--audit-log <file>`  | 監査ログをファイルに出力（拡張子でJSON/CSVを自動判定）                       |
| `--json`              | 結果をJSON形式で出力                                                         |
| `--ci`                | CIモード: 対話プロンプトとプログレスバーを無効化。失敗時は終了コード1        |

**なぜ mask より sync か？**

- **高速** — ネイティブダンプ/リストアは行単位ストリーミングより大幅に速い
- **完全** — ダンプにはインデックス、トリガー、ビュー、ストアドプロシージャが含まれる。`--sync-schema` 不要
- **設定がシンプル** — PIIカラムだけ定義すればよい。非PIIテーブルはダンプで自動コピー
- **ダウンタイムゼロ** — アトミックスワップにより同期中もターゲットDBは利用可能
- `copyOnly` と `incremental` は無視される（全テーブルがダンプでコピー）

#### `mask` から `sync` への移行

`shinobidb mask` を使用中の場合、`sync` への移行は簡単です:

1. スクリプト中の `shinobidb mask` を `shinobidb sync` に置換
2. `--sync-schema` を削除（ダンプにスキーマが含まれる）
3. `--full-refresh` を削除（sync は常にフルコピー）
4. 設定の `copyOnly: true` は無視される — 全テーブルがダンプでコピー
5. `incremental` は無視される — sync は常にフルダンプ

既存の `shinobidb.yaml` はそのまま `sync` で動作します。変更はコマンド名だけです。

> **前提条件:** `sync` にはネイティブDBツールのインストールが必要です:
>
> - **MySQL:** `mysqldump` と `mysql` クライアント
> - **PostgreSQL:** `pg_dump` と `psql`
> - **MongoDB:** `mongodump` と `mongorestore`

### `shinobidb mask` _（非推奨）_

> **Note:** `mask` は `sync` に置き換えられました。新規セットアップには `shinobidb sync` を使用してください。[mask から sync への移行](#mask-から-sync-への移行)を参照。

設定ファイルに基づいてデータをコピーし、マスキング戦略を適用します。

```bash
shinobidb mask \
  [-c <config-file>] \
  --source-password <password> --target-password <password> \
  [--dry-run] [--sample-rows <n>] [--json] \
  [--concurrency <n>] [--sync-schema] \
  [--audit-log <file>] [--full-refresh] [--no-progress]
```

パスワードは設定ファイルに保存されません。CLIフラグ、環境変数（`SHINOBIDB_SOURCE_PASSWORD` / `SHINOBIDB_TARGET_PASSWORD`）、または省略して対話プロンプトで入力できます。設定ファイルのデフォルトパスは `shinobidb.yaml`（カレントディレクトリ）。

| オプション           | 説明                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `--dry-run`          | ターゲットに書き込まずにマスキング結果をプレビュー。テーブルごとのbefore/afterサンプル行を表示 |
| `--sample-rows <n>`  | dry-runで表示するサンプル行数（デフォルト: 3）                                                 |
| `--json`             | dry-run結果をJSON形式で出力                                                                    |
| `--concurrency <n>`  | 並列処理するテーブル数（デフォルト: 1）                                                        |
| `--sync-schema`      | ソースのスキーマからターゲットに不足テーブルを自動作成                                         |
| `--audit-log <file>` | 監査ログをファイルに出力。拡張子で形式を自動判定（`.json` または `.csv`）                      |
| `--full-refresh`     | 増分同期テーブルの同期状態をリセットしてフルコピーを強制                                       |
| `--no-progress`      | プログレスバーを無効化                                                                         |

### `shinobidb drift`

マスキング設定と現在のDBスキーマのドリフト（乖離）を検出します。設定に未定義のPIIカラム、DBに存在しないテーブル/カラム、PIIを含む`copy_only`テーブルを発見します。

```bash
shinobidb drift <config-path> \
  [--schemas <s1,s2>] [--tables <t1,t2>] \
  [--sample-content] [--min-confidence <0.6>] \
  [--json] [--apply]
```

| オプション         | 説明                                   |
| ------------------ | -------------------------------------- |
| `--json`           | JSON出力（CI連携用）                   |
| `--apply`          | 検出結果で設定ファイルを自動更新       |
| `--min-confidence` | PII検出の最小信頼度（デフォルト: 0.5） |
| `--sample-content` | 実データをサンプリングしてPII検出      |

アクション可能なドリフト（critical/warning）検出時は終了コード1。既知の誤検知は`ignore`フィールドで除外:

```yaml
ignore:
  - mydb.users.display_name
  - mydb.logs.user_agent
```

**CI連携:** GitHub Actionsのサンプルワークフローを[`examples/ci/`](examples/ci/)に用意しています:

- [`drift-check.yml`](examples/ci/drift-check.yml) — 定期drift検出 + Slack通知
- [`drift-check-pr.yml`](examples/ci/drift-check-pr.yml) — PR変更時にdrift結果をコメント投稿

### `shinobidb validate`

DBに接続せずに設定ファイルの妥当性を検証します。未知の戦略名、テーブル/カラムの重複、増分同期カラムの競合などをチェックします。

```bash
shinobidb validate [-c <config-file>] [--json]
```

### スキーマ変更検知

スナップショットを使ってPIIカラムの変更を追跡:

```bash
# ベースラインのスナップショットを保存
shinobidb scan ... --snapshot

# 後日、現在のスキーマと比較
shinobidb scan ... --diff

# スナップショットの保存と比較を同時に
shinobidb scan ... --snapshot --diff
```

差分出力はCIパイプラインに組み込めます（変更検出時に終了コード1）。

### グローバルオプション

- `-v, --verbose` — デバッグログとスタックトレースを有効化

## 設定ファイル

`shinobidb config` で生成、手動編集も可能:

```yaml
version: '1'
source:
  type: mysql
  host: localhost
  port: 3306
  user: root
  database: production_db
target:
  type: mysql
  host: localhost
  port: 3307
  user: root
  database: staging_db
options:
  batchSize: 1000
  deterministic: true
  seed: shinobidb-default-seed
  truncateTarget: true
tables:
  - schema: production_db
    table: users
    columns:
      - name: email
        strategy: hash_email
      - name: first_name
        strategy: fake_first_name
      - name: phone
        strategy: fake_phone
```

**主要オプション:**

- `truncateTarget: true` — コピー前にターゲットテーブルの**既存データをすべて削除**します。`false`にすると追記モード。
- `deterministic: true` — 同じ入力は常に同じマスク結果を生成（参照整合性の維持に有用）。
- `batchSize` — バッチあたりの処理行数（デフォルト: 1000）。

### コピー専用テーブル

PIIのないテーブルはマスキングなしでそのままコピー:

```yaml
tables:
  - schema: production_db
    table: categories
    copyOnly: true
```

`shinobidb config --include-all-tables` を使うと、PII未検出のテーブルも `copyOnly: true` として設定に含まれます。

### 増分同期

毎回フルコピーする代わりに、前回以降の変更行のみをコピー:

```yaml
tables:
  - schema: production_db
    table: orders
    incremental:
      strategy: timestamp # または 'cursor'
      column: updated_at # 変更追跡に使うカラム
    columns:
      - name: customer_email
        strategy: hash_email
```

- **`timestamp`** — カラム値が前回実行時より新しい行を同期
- **`cursor`** — カラム値が前回のカーソル位置より大きい行を同期（例: オートインクリメントID）
- 同期状態は `.shinobidb/sync-state.json` に保存
- `--full-refresh` で状態をリセットしてフルコピーを強制

## マスキング戦略

| 戦略              | 説明                                                         |
| ----------------- | ------------------------------------------------------------ |
| `hash_email`      | ドメインを保持した決定論的ハッシュ（例: `a1b2@example.com`） |
| `fake_name`       | ランダムなフルネーム                                         |
| `fake_first_name` | ランダムな名前                                               |
| `fake_last_name`  | ランダムな姓                                                 |
| `fake_phone`      | ランダムな電話番号                                           |
| `fake_address`    | ランダムな住所                                               |
| `hash_ip`         | 有効なIPv4を生成する決定論的ハッシュ                         |
| `random_date`     | 指定範囲内のランダムな日付                                   |
| `redact`          | `[REDACTED]` に置換                                          |
| `scrub_text`      | フリーテキスト内のメール・IP・電話番号を検出して置換         |

### カスタム戦略

独自のマスキング戦略をJS/TSファイルで定義し、設定から参照できます:

```yaml
customStrategies:
  - ./my-strategies.js

tables:
  - schema: mydb
    table: users
    columns:
      - name: nickname
        strategy: custom_prefix
        params:
          prefix: 'user'
```

```js
// my-strategies.js
export default {
  name: 'custom_prefix',
  mask(value, context, seed) {
    if (typeof value !== 'string') return value;
    const prefix = context.params?.prefix ?? 'MASKED';
    return `${prefix}_${value}`;
  },
};
```

## 開発

```bash
npm run typecheck    # TypeScript型チェック
npm run lint         # ESLint
npm test             # ユニットテスト
```

### E2Eテスト

E2EテストはDockerで起動した実DBインスタンスに対して実行:

```bash
docker compose up -d          # MySQL, PostgreSQL, MongoDB を起動
npm run test:e2e              # E2Eテスト実行
docker compose down           # 停止
```

## ライセンス

MIT
