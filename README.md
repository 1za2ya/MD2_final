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

8コインのデータ収集用`basic`ステージだけを使用します。迷路、CSS、クライアントJavaScriptは`public/index.html`へ集約しています。

## CSV出力

一般プレイヤーの結果画面からCSVは取得できません。起動時に表示される管理トークン、または`MD2_EXPORT_TOKEN`で設定したトークンを`x-export-token`ヘッダーへ指定します。

```bash
MD2_EXPORT_TOKEN=管理用トークン npm start
curl -H "x-export-token: 管理用トークン" http://localhost:3000/api/export/sessions --output sessions.csv
```

エンドポイント名は`sessions`、`movement_logs`、`coin_logs`、`event_logs`です。各CSVは認証後のダウンロードと同時に`data/exports/`へ保存されます。

`movement_logs.csv` はA-FrameのX-Z平面を分析用の `pos_x`・`pos_y` として0.1秒ごとに記録し、約5秒分（50件）ずつ一括保存します。出力時はセッションと経過時間の順に整列されます。

`coin_logs.csv`には取得時の経過時間、取得済み数、残数も保存し、同じセッション・コインIDの重複ログはSQLite側でも拒否します。

## Python分析（最優先）

Python環境を準備します。

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

4種類のCSVを出力した後に実行します。

```bash
npm run analyze
```

集計CSV、相関表、散布図、比較用移動経路図、コイン取得順、マルチプレイ経路図、ヒートマップが`analysis_output/`へ作成されます。ゲームやCSVを変更するときは、Python分析との互換性を最優先で確認してください。

## WebXRでの利用

`npm start`後、同じPCでは`http://localhost:3000`を開き、画面のVRボタンからWebXRへ入ります。HTMLファイルを直接開くのではなく、必ず`server.js`経由でアクセスしてください。

別のヘッドセットや端末からWebXRを利用する場合、WebXRのセキュリティ要件によりHTTPSでアクセスできるNode.js配信先が必要です。WebXR自体はファイルを保存・配信するサービスではないため、`index.html`だけをWebXRへ投入してSocket.IO、SQLite3、CSVを動かすことはできません。
