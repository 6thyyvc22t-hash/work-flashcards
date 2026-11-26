# 仕事理解用デジタル単語帳

更新：2026-11-26
ベース：AP最新版 68aa15d44b67549560825192ac2674479ad6d4a8。AP側のコード・問題・成績・メモは変更しない。
現在：ソース一式を非公開知識ベースに配置。Pages未公開、Firebase未設定。

## 配置と起動
1. GitHubで新規リポジトリ work-flashcards を作成。知識ベース自体は非公開のままにする。
2. このディレクトリの全ファイル（index.html、app.js、styles.css、questions.json、cloud-sync.js、deck-sync.js、memo-sync.js、firebase-config.json、firestore.rules、README.md）のみを新リポジトリのルートに配置。
3. Settings → Pages → Deploy from a branch → main / (root) を設定する。公開後、Safariで https://6thyyvc22t-hash.github.io/work-flashcards/ を開く。共有→ホーム画面に追加。
4. Firebase未設定でも端末内学習は可能。HTML直接開きではなくHTTPで配信する。

## クラウド設定（別プロジェクト必須）
1. Firebase Consoleで仕事専用の新規プロジェクトを作成。プロジェクトIDは work-flashcards- で始まる一意のIDにする（コードで検証）。APの既存プロジェクトを使用しない。
2. Webアプリを登録し、Authenticationのメール/パスワードを有効化。Authorized domainsに GitHub Pages のホスト名を追加。
3. Firestore Databaseを作成し、本ディレクトリの firestore.rules の全文を**仕事用プロジェクトにのみ**公開する。
4. Web設定JSONを単語帳のFirebase設定に貼り付ける。全端末で利用する場合、公開用Web設定だけを firebase-config.json に配置する。サービスアカウント秘密鍵は禁止。
5. 仕事用アカウントを作り、iPhone/iPadで同じアカウントにログイン。同期済みを確認。
6. APの学習状況に変化がないことを確認する。

## 分離設計
- deckId: work-it、ブラウザ保存キー: work-flashcards-*、Firebaseアプリ名: work-flashcards-sync。
- Firestore: workUsers/{uid}/cards、notes、deckChanges、operations。APの users 配下を参照しない。
- APの旧端末記録自動移行および旧AP形式のバックアップ取り込みを削除。仕事用の端末→仕事用クラウドへの移行は維持。
- 学習記録・メモのバックアップは仕事用typeとdeckIdで検証。問題JSONもdeckIdで検証。
- APのFirebase設定は複製しない。初期の成績・メモ・個人差分は空。

## 引継ぎ機能
順番・ランダム・未学習・要復習の出題、分野指定、任意開始位置（ランダム除く）、カード反転、正解/不正解/スキップ、累積正誤回数、学習済み/正答率/要復習/メモあり集計、問題別メモ、検索、追加/編集/保管/復元/完全削除、JSONバックアップ/復元、端末保存・クラウド同期・オフライン再送・操作IDによる二重加算防止、個人別カード差分。正答率は正解/(正解+不正解)、スキップ非加算、最新の採点が不正解なら要復習。

## 問題の運用
初期1問のみ。候補は別途提示し、ユーザーが選んだ問題だけ共通 questions.json に登録する。用語・仕組み・比較・構成上の位置・設計レビューを扱い、1カード1論点。分野は questions.json の12分野。
共通IDは nextId で採番し再利用しない。個人追加は u+UUID。意味が変わる編集は新ID。公開原本変更時に revision と nextId を更新し再取得確認。個人差分込みの書き出しを公開原本へ無条件に上書きしない。
共通原本の出典は知識ベースの一般化済み用語集・知識マップ。事実と推測を区別する。問題/答え各400字、解説/ポイント各600字、出典1000字、メモ2000字以内。

## 機密保護
公開JSON・アーカイブ・過去コミットは第三者から閲覧可能。ログインは公開ファイルを隠さない。会社名・内部システム名・実構成・運用数値・会議原文・顧客情報・秘密情報を登録しない。メモや個人追加も一般知識のみ。非公開知識ベースを公開しない。

## 受入確認
- 初回1問、未学習・正誤0/0。反転、採点、スキップ、復習解除、開始位置、集計。
- 問題追加、編集、保管、復元、完全削除、検索、JSON保存/復元。APバックアップを拒否。
- 同一オリジンでAPと仕事版の成績・メモ・削除状態が混ざらない。
- 別Firebaseで端末間同期、メモ、問題差分、オフライン再送・重複防止、他UID拒否を確認。
- 仕事版の設定・ルール・公開サイト・iPhone/iPadでの実動作は公開後に確認する。
