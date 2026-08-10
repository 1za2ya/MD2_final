# Maze Trace XR 現行仕様

この文書は現在の実装だけを定義する。Python分析を研究上の最優先機能とし、ゲーム変更時も分析可能性を損なってはならない。過去の追加ステージ、参加コード、分割フロントエンドの仕様は廃止済みとする。

## 1. 目的

A-Frame / WebXRの3D迷路で8個のコインを集め、探索行動をSQLite3へ記録する。ソロとSocket.IOによる2人以上のマルチプレイに対応する。

## 2. 最小ファイル構成

- `public/index.html`：HTML、CSS、クライアントJavaScript
- `server.js`：Express、Socket.IO、basic設定、SQLite3、CSV API
- `analysis.py`：pandasによる集計とmatplotlibによる可視化
- `requirements.txt`：Python分析依存
- `package.json` / `package-lock.json`：Node.js依存と起動設定
- `tests/rounds.integration.js`：basicと連続ラウンドの統合テスト
- `README.md`：利用手順

CSSやクライアントJavaScriptを別ファイルへ重複分割しない。Python分析ファイルは削除・代替・簡略化しない。

## 3. ステージ

ステージは`basic`だけとする。

- 表示名：`Basic Research Stage`
- `maze_id`：`basic`
- `coin_layout_id`：`basic_v1`
- 開始セル：`[1, 1]`
- コイン数：8
- 参加コード：なし

迷路：

```text
111111111
100000001
101110101
100010101
111010101
100010001
101111101
100000001
111111111
```

コインセル：

```text
[1,3], [1,7], [3,1], [3,5], [5,1], [5,7], [7,3], [7,7]
```

サーバーの`GET /api/stage`を唯一のステージ設定元とし、クライアントは開始時に取得する。

## 4. ゲーム

- WASD移動、マウス視点、WebXRに対応する
- 壁衝突をクライアントで判定する
- 全8コイン取得でクリアする
- HUDに時間、取得数、総数、残数、マルチプレイ順位を表示する
- コイン取得時は右上HUDを約300ms発光させる
- `prefers-reduced-motion`では拡大を省略する
- 暗い床と明るい壁の差を保ち、視認性を優先する

## 5. 連続プレイ

- プレイごとに新しい`session_id`を発行する
- 同じプレイヤーの連続試行を`trial_number`と`previous_session_id`で追跡する
- ソロは結果表示後に次の試行へ進める
- マルチプレイは同じルームを維持し、全員が`NEXT GAME`を選ぶと次ラウンドを開始する
- マルチプレイのラウンドは`round_number`で追跡する
- 開始時刻はサーバー時刻を基準にする
- 一時切断には15秒の再接続猶予を設ける

## 6. 行動ログ

クライアントは位置を0.1秒間隔で記録し、50件ずつ一括送信する。1件ごとのAPI送信へ変更しない。

SQLite3の正本テーブル：

- `players`
- `sessions`
- `movement_logs`
- `coin_logs`
- `event_logs`

`movement_logs`ではA-FrameのX-Z平面を分析用の`pos_x`・`pos_y`として保存する。同じ`session_id`と`elapsed_time`の重複を許可しない。

`coin_logs`では同じ`session_id`と`coin_id`の重複を許可しない。

## 7. CSV

SQLite3を正本とし、CSVは管理者が要求した時点のスナップショットとする。

エンドポイント：

- `/api/export/sessions`
- `/api/export/movement_logs`
- `/api/export/coin_logs`
- `/api/export/event_logs`

すべて`x-export-token`ヘッダーを必要とする。トークンは`MD2_EXPORT_TOKEN`で設定し、HTMLやクライアントJavaScriptへ渡さない。一般プレイヤーの結果画面にCSVリンクを表示しない。

## 8. Python分析（最優先）

`analysis.py`は`data/exports/`の`sessions.csv`、`movement_logs.csv`、`coin_logs.csv`を読み込み、次を生成する。

- 0.1秒座標ログからの総移動距離再計算
- クリア時間、距離、停止、再訪問の集計
- 相関表
- セッション指標の散布図
- コイン取得順と移動経路の比較図
- マルチプレイ経路図
- 移動ヒートマップ

出力先は`analysis_output/`とする。CSV列を変更する場合は、先に`analysis.py`との互換性を確認する。ゲーム機能の簡素化を理由にPython分析を削除してはならない。

## 9. サーバー

- ExpressとSocket.IOを同じHTTPサーバーで動かす
- 静的ファイル、A-Frame、API、Socket.IOを同一オリジンで配信する
- クライアントは`io()`で同一オリジンへ接続する
- `process.env.PORT || 3000`を使用する
- `0.0.0.0`で待ち受ける
- 不要なCORS許可を追加しない
- SQL値はプレースホルダーで渡す
- 起動、Socket.IO接続・切断、セッション開始・終了、VR移行、コインのDB保存を標準出力と`data/service.log`にJSON Lines形式で記録する
- 0.1秒ごとの移動ログは`game.db`にのみ保存し、`service.log`を過剰に増やさない

## 10. WebXRとローカル保存

環境変数なしでは次を使用する。

```text
data/game.db
data/exports/
```

DB初期化は不足テーブルや列だけを追加し、既存データを削除しない。

WebXR画面は必ず`server.js`から配信する。PC自身では`http://localhost:3000`を使用できる。別のWebXR端末から利用する場合は、WebXRのSecure Context要件を満たすHTTPS配信を別途用意する。WebXR自体にはHTMLやサーバーを保存・実行する機能はない。

## 11. 変更方針

- basic以外のステージを追加しない
- 参加コード、ステージトークン、ステージ別分岐を追加しない
- 同じ定数や設定を複数ファイルへ重複させない
- 既存のログ列とCSV列順を不用意に変更しない
- ソロ、マルチプレイ、連続ラウンド、WebXR、SQLite3、Python分析を維持する
- 特定のクラウドサービス専用ファイル、変数、説明を追加しない
- 実行に不要なファイル、依存、コメントを増やさない

## 12. 検証

変更後は最低限、次を確認する。

```bash
npm run check
npm run test:rounds
npm run analyze
```

ブラウザでは参加コード欄がないこと、Basic表示、コイン総数8、ソロ開始、マルチプレイの同室参加を確認する。
