# 将棋 — 本格AI対戦

Next.js + TypeScriptで作ったブラウザ将棋です。最高レベルでは、やねうら王と内蔵評価関数の水匠ぷちをブラウザ内で実行します。

## 起動

```bash
npm install   # postinstallでブラウザ用エンジンをpublic/engineへ配置
npm run dev
```

http://localhost:3000 を開いて対局を開始できます。

## 機能

- 形勢バー、評価値、AIの読み筋
- ヒント、棋譜表示・コピー
- 成る・成らず、待った、投了、先後選択、千日手判定
- 駒落ちとスマートフォン表示

## 強さレベル

| レベル | エンジン | 思考時間 |
|---|---|---|
| やさしい | 内蔵JS探索（ノイズ大） | 0.3秒 |
| ふつう | 内蔵JS探索（ノイズ小） | 0.6秒 |
| つよい | やねうら王 + 水匠ぷち（K-P） | 0.6秒 |

SharedArrayBufferを利用できない環境では、内蔵JS探索へ自動的に切り替わります。

## 主な構成

- `lib/shogi.ts` — ルールエンジン
- `lib/usi.ts` — SFEN / USI変換
- `lib/engine.ts` — やねうら王WASMラッパー
- `lib/ai.ts` — フォールバック用JS探索
- `components/ShogiGame.tsx` — 盤面UI
- `scripts/copy-engine.mjs` — npmパッケージから配信用エンジンを配置

## ライセンスと対応ソース

このプロジェクトはGNU General Public License v3.0で公開します。全文は[LICENSE](./LICENSE)を参照してください。

ブラウザへ配信するエンジンは`@mizarjp/yaneuraou.k-p`バージョン`7.6.3-alpha.0`です。正確な依存バージョンは`package-lock.json`、配置方法は`scripts/copy-engine.mjs`に記録されています。

- [YaneuraOu.wasm対応ソース（使用パッケージのgit commit）](https://github.com/mizar/YaneuraOu.wasm/tree/c9c34f240f89b611ca34060466e61220b0d3180c)
- [やねうら王](https://github.com/yaneurao/YaneuraOu)
- 詳細な著作権表示は[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)

公開時は、このリポジトリ自体を公開し、Vercelで配信しているコミットと取得可能なソースを一致させてください。

## 公開前チェック

- GitHubリポジトリをPublicにする
- Vercelのデプロイ対象が公開リポジトリ上のコミットであることを確認する
- サイトの「ライセンス・ソースコード」ページに公開リポジトリURLを設定する
- Vercel環境変数`NEXT_PUBLIC_SOURCE_URL`に、その公開リポジトリURLを設定する

入玉宣言（持将棋）ルールは未対応です。エンジンが`win`を宣言した場合はAI勝ちとして扱います。
