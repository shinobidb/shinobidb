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

```bash
# 1. ソースDBをスキャンしてPIIカラムを検出
shinobidb scan --host localhost --port 3306 --user root --password secret --schemas mydb

# 2. スキャン結果からマスキング設定を生成
shinobidb config --host localhost --port 3306 --user root --password secret --schemas mydb -o shinobidb.yaml

# 3. shinobidb.yaml を編集（ターゲット接続先の設定、マスキングルールの確認）

# 4. マスキング実行
shinobidb mask --source-password secret --target-password secret
```

## CLIコマンド

### 接続オプション

DB接続が必要なコマンドは、個別フラグまたは接続URIのどちらでも指定可能:

```bash
# 個別フラグ
shinobidb scan --host localhost --port 3306 --user root --password secret --schemas mydb

# 接続URI（MySQL, PostgreSQL, MongoDB）
shinobidb scan --uri mysql://root:secret@localhost:3306/mydb
shinobidb scan --uri postgres://user:pass@localhost:5432/mydb
shinobidb scan --uri mongodb://user:pass@localhost:27017/mydb
```

### `shinobidb scan`

DBに接続してスキーマを読み取り、カラム名パターンからPIIカラムを検出します。

```bash
shinobidb scan \
  --host <host> --port <port> --user <user> --password <password> \
  [--uri <uri>] \
  [--type mysql|postgres|mongodb] [--database <db>] [--schemas <s1,s2>] [--tables <t1,t2>] \
  [--sample-content] [--json]
```

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

### `shinobidb mask`

設定ファイルに基づいてデータをコピーし、マスキング戦略を適用します。

```bash
shinobidb mask \
  [-c <config-file>] \
  --source-password <password> --target-password <password> \
  [--dry-run] [--sample-rows <n>] [--json] \
  [--concurrency <n>] [--sync-schema] \
  [--audit-log <file>] [--full-refresh] [--no-progress]
```

パスワードはCLIフラグで渡します（設定ファイルには保存されません）。

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
