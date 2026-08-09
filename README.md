# Maze Trace XR

A-Frame / WebXR による3D迷路型コイン収集ゲームです。solo と Socket.IO を利用した multiplayer に対応し、客観的な行動ログを SQLite3 へ保存します。

## 起動

```bash
npm install
npm start
```

ブラウザで `http://localhost:3000` を開きます。マルチプレイは、2つ以上のブラウザで同じルームIDを入力すると全員の準備後に開始します。

クリア後は入力画面へ戻らず、プレイヤー情報を引き継いで連続プレイできます。ソロでは短い結果表示後に自動で次の試行へ進み、マルチプレイでは同じルームの全員が「NEXT GAME」を選ぶと次ラウンドがサーバー時刻基準で始まります。「終了」を選ぶと連続プレイまたはルームから退出できます。

各プレイには新しい`session_id`が割り当てられ、`trial_number`、マルチプレイの`round_number`、直前の`previous_session_id`によって連続した試行を追跡できます。

コイン取得時は、右上のHTMLステータスバーに取得数・総数・残数・時間を表示し、約300msだけ発光します。動きの軽減設定では拡大を省略し、自分以外のコイン取得では発光しません。

## ステージ

コードを空欄にすると、8コインのデータ収集用`basic`ステージになります。開発用の追加ステージコードは以下です。

- `FOREST-XR`：6コイン
- `CROSS-XR`：10コイン
- `SPIRAL-XR`：7コイン
- `GRID-XR`：12コイン

運用時は`MD2_STAGE_FOREST_CODE`、`MD2_STAGE_CROSSROADS_CODE`、`MD2_STAGE_SPIRAL_CODE`、`MD2_STAGE_GRID_CODE`で変更できます。同じマルチプレイルームでは同じステージだけを使用できます。

## CSV出力

一般プレイヤーの結果画面からCSVは取得できません。起動時に表示される管理トークン、または`MD2_EXPORT_TOKEN`で設定したトークンを`x-export-token`ヘッダーへ指定します。

```bash
MD2_EXPORT_TOKEN=管理用トークン npm start
curl -H "x-export-token: 管理用トークン" http://localhost:3000/api/export/sessions --output sessions.csv
```

エンドポイント名は`sessions`、`movement_logs`、`coin_logs`、`event_logs`です。各CSVは認証後のダウンロードと同時に`data/exports/`へ保存されます。

`movement_logs.csv` はA-FrameのX-Z平面を分析用の `pos_x`・`pos_y` として0.1秒ごとに記録し、約5秒分（50件）ずつ一括保存します。出力時はセッションと経過時間の順に整列されます。

`coin_logs.csv`には取得時の経過時間、取得済み数、残数も保存し、同じセッション・コインIDの重複ログはSQLite側でも拒否します。

## 分析

4種類のCSVを出力した後、pandas と matplotlib を導入した環境で実行します。

```bash
python analysis.py
```

集計CSV、相関表、散布図、比較用移動経路図、コイン取得順・停止候補、マルチプレイ経路図、ヒートマップが `analysis_output/` に作成されます。

## Railwayへのデプロイ

このアプリはRailwayの`PORT`を使用し、Express・A-Frame・API・Socket.IOを同じHTTPサーバーから配信します。クライアントも同一オリジンへ接続するため、Railway用のURLをコードへ埋め込む必要はありません。

1. このプロジェクトをGitHubリポジトリへ追加し、Railwayで「New Project」からそのリポジトリを選択します。
2. 作成されたServiceにVolumeを追加し、Mount Pathを`/data`に設定します。
3. ServiceのVariablesに次を設定します。`PORT`はRailwayが自動設定するため追加しません。

   ```text
   NODE_ENV=production
   DATABASE_PATH=/data/game_data.db
   MD2_EXPORT_TOKEN=十分に長い管理用トークン
   ```

4. 「Public Networking」で公開ドメインを生成し、表示されたHTTPS URLへアクセスします。
5. 別のPCまたはスマートフォンからも同じURLを開き、同じルームIDでマルチプレイを確認します。
6. Railwayの再起動または再デプロイ後、セッション数が維持されていることをCSV出力またはDBで確認します。

`DATABASE_PATH`を指定すると、DBの親ディレクトリに`exports/`が作られます。上記設定ではDBが`/data/game_data.db`、認証済みCSVスナップショットが`/data/exports/`に保存されます。SQLite3が正本であり、CSVはエクスポート時点の分析用スナップショットです。ローカルでは環境変数なしで従来通り`data/game.db`と`data/exports/`を使用します。

現在のSocket.IOルーム管理はNode.jsのメモリ上にあるため、RailwayではServiceを1インスタンスで運用してください。複数インスタンスへ水平スケールする場合は、将来的にRedis Adapterなどの共有ルーム基盤が必要です。Volumeは1サービスに接続し、SQLite DBを複数インスタンスから同時利用しないでください。

本番用の`MD2_EXPORT_TOKEN`はGitHubへ書かず、Railway Variablesだけに保存してください。追加ステージコードも必要に応じて`MD2_STAGE_FOREST_CODE`、`MD2_STAGE_CROSSROADS_CODE`、`MD2_STAGE_SPIRAL_CODE`、`MD2_STAGE_GRID_CODE`としてVariablesへ設定できます。
