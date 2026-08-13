import ShogiGame from "@/components/ShogiGame";

export default function Home() {
  return (
    <div className="appShell">
      <header className="appHeader">
        <div className="brand">
          <span className="brandMark" aria-hidden>
            ☗
          </span>
          <h1>将棋 本格AI対戦</h1>
        </div>
        <p className="engineBadge">やねうら王 + 水匠ぷち搭載</p>
      </header>
      <main className="appMain">
        <ShogiGame />
      </main>
      <footer className="appFooter">
        <a href="/licenses">ライセンス・ソースコード</a>
      </footer>
    </div>
  );
}
