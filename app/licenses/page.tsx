const sourceUrl = process.env.NEXT_PUBLIC_SOURCE_URL;

export default function LicensesPage() {
  return (
    <main className="legalPage">
      <h1>ライセンス・ソースコード</h1>
      <p>
        このサイトのプログラムはGNU General Public License v3.0で提供されます。
        無保証であり、同ライセンスの条件に従って再配布・変更できます。
      </p>
      <h2>対応ソースコード</h2>
      {sourceUrl ? (
        <p><a href={sourceUrl}>このサイトで配信しているバージョンのソースコード</a></p>
      ) : (
        <p className="legalWarning">
          運営者向け: VercelにNEXT_PUBLIC_SOURCE_URLを設定し、公開リポジトリへのリンクを掲載してください。
        </p>
      )}
      <h2>やねうら王 WebAssembly版</h2>
      <p>
        AIの「つよい」レベルには、GPLv3で提供される
        <a href="https://github.com/mizar/YaneuraOu.wasm"> YaneuraOu.wasm</a>の
        <code>@mizarjp/yaneuraou.k-p@7.6.3-alpha.0</code>を使用しています。
        評価関数として水匠ぷち（SuishoPetite 2021-11）を内蔵しています。
      </p>
      <p>
        <a href="/LICENSE.txt">GPLv3ライセンス全文</a>
        {" / "}
        <a href="/engine/README.md">配信エンジンの説明・著作権表示</a>
        {" / "}
        <a href="https://github.com/yaneurao/YaneuraOu">やねうら王</a>
      </p>
      <p><a href="/">対局画面へ戻る</a></p>
    </main>
  );
}
