# 体験記チェッカー（一次チェック専用・単独版）

アンケート・本文の校正と、タイトル案づくりだけを行うツールです。画像編集は含まれません。

## ファイル構成
```
checker/
├── index.html
├── css/style.css          ← 新デザイン（Midnight / Pearl。システムの設定で自動切替、左下のボタンで手動切替）
└── js/
    ├── rules.js           ← 【変更なし】ルール定義。ルールの追加・変更はここだけ
    ├── rule-engine.js     ← 【変更なし】決定的チェック
    ├── gemini-client.js   ← 【変更なし】Gemini通信
    └── app.js             ← 【新規】画面操作・プロンプト・結果表示
```

## 以前のチェッカーとの違い
- 「画像編集」タブと image-editor.js を削除（単独ツールにした）
- タブは「アンケート／本文校正／タイトル案」の3つ（旧：本文タブ内のラジオ切替を独立）
- 各指摘に「採用／不採用／要相談」の判断ボタンと、集計・コピー機能を追加
- 「ルールのみ（送信なし）」ボタンを追加（AIを使わず、どこにも送信しない）
- AIチェックの前に「伏せ字にしました」のチェックが必要（js/app.js 冒頭の CONFIG.REQUIRE_MASK_CONFIRM を false にすると無効）
- 本文校正で、指摘箇所をプレビュー上にハイライト

## 注意
- app.js は、元の app.js を見ずに新しく書き直したものです。プロンプトの文面や、アンケートの分割方法（「掲載する」を区切りにする）は、元の動作を推定して作っています。差があれば app.js の buildSurveyPrompt / buildProofPrompt / buildTitlePrompt / parseSurvey を調整してください。
- 文字は Google Fonts（Shippori Mincho B1 / Zen Kaku Gothic New）を読み込みます。オフラインでは、システムの明朝・ゴシックで表示されます。

## 公開方法
画像編集ツールのREADMEと同じです。Cloudflare Pages では、functions/_middleware.js（ID・パスワード認証）をリポジトリのルートに置いたまま、このフォルダの中身を公開してください。
