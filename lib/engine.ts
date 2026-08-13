// やねうら王 WASM のブラウザ用ラッパー
// NNUE K-P(水匠ぷち内蔵)。約1.4MB で即起動。
// エンジン本体は public/ に配置し、グローバルスクリプトとして読み込む
// (バンドラーを介さないので Turbopack/webpack の差異に影響されない)

export type EngineStatus = "idle" | "loading" | "ready" | "failed";
export type EngineVariant = "kp";

interface YaneuraOuModule {
  addMessageListener: (listener: (line: string) => void) => void;
  removeMessageListener: (listener: (line: string) => void) => void;
  postMessage: (command: string) => void;
  terminate: () => void;
  FS: {
    mkdir: (path: string) => void;
  };
}

type EngineFactory = (config: object) => Promise<YaneuraOuModule>;

declare global {
  interface Window {
    YaneuraOu_K_P?: EngineFactory;
  }
}

const VARIANTS: Record<EngineVariant, {
  script: string;
  dir: string;
  globalName: "YaneuraOu_K_P";
  displayName: string;
}> = {
  kp: {
    script: "/engine/yaneuraou.k-p.js",
    dir: "/engine/",
    globalName: "YaneuraOu_K_P",
    displayName: "やねうら王(水匠ぷち)",
  },
};

export interface EngineInfo {
  depth: number;
  nodes: number;
  scoreCp: number | null; // エンジン手番視点の評価値
  scoreMate: number | null; // 詰み手数(正: エンジン勝ち)
  pv: string[]; // USI 指し手列
}

export interface EngineSearchResult extends EngineInfo {
  bestmove: string; // USI 指し手 / "resign" / "win"
}

export type ProgressCallback = (phase: "script" | "init", percent: number | null) => void;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export class YaneuraOuEngine {
  readonly variant: EngineVariant;
  status: EngineStatus = "idle";
  onProgress: ProgressCallback | null = null;
  private module: YaneuraOuModule | null = null;
  private listeners = new Set<(line: string) => void>();
  private initPromise: Promise<boolean> | null = null;
  private searchChain: Promise<unknown> = Promise.resolve();

  constructor(variant: EngineVariant) {
    this.variant = variant;
  }

  get displayName(): string {
    return VARIANTS[this.variant].displayName;
  }

  init(): Promise<boolean> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<boolean> {
    if (typeof window === "undefined" || typeof SharedArrayBuffer === "undefined") {
      this.status = "failed";
      return false;
    }
    const conf = VARIANTS[this.variant];
    this.status = "loading";
    try {
      this.onProgress?.("script", null);
      await loadScript(conf.script);
      const factory = window[conf.globalName];
      if (!factory) throw new Error("engine factory not found");
      const mod = await withTimeout(
        factory({
          locateFile: (f: string) => conf.dir + f,
          mainScriptUrlOrBlob: conf.script,
        }),
        30000
      );
      this.module = mod;
      mod.addMessageListener((line: string) => {
        for (const l of this.listeners) l(line);
      });
      this.onProgress?.("init", null);
      await withTimeout(this.cmdWait("usi", "usiok"), 15000);
      const threads = Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 2));
      // モバイル端末のメモリ圧迫を避けるため控えめに(0.6秒探索には十分)
      this.post("setoption name USI_Hash value 128");
      this.post(`setoption name Threads value ${threads}`);
      this.post("setoption name NetworkDelay value 0");
      this.post("setoption name NetworkDelay2 value 0");
      await withTimeout(this.cmdWait("isready", "readyok"), 60000);
      this.post("usinewgame");
      this.status = "ready";
      return true;
    } catch (e) {
      console.error(`engine(${this.variant}) init failed:`, e);
      this.status = "failed";
      return false;
    }
  }

  private post(cmd: string) {
    this.module?.postMessage(cmd);
  }

  private cmdWait(cmd: string, waitPrefix: string): Promise<string> {
    return new Promise(resolve => {
      const listener = (line: string) => {
        if (line.startsWith(waitPrefix)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
      this.post(cmd);
    });
  }

  newGame() {
    if (this.status === "ready") this.post("usinewgame");
  }

  // 探索は直列化する(前の探索が終わる前に次を積んでも混線しない)
  search(
    sfen: string,
    movetimeMs: number,
    onInfo?: (info: EngineInfo) => void
  ): Promise<EngineSearchResult> {
    const run = this.searchChain.then(() => this.doSearch(sfen, movetimeMs, onInfo));
    this.searchChain = run.catch(() => {});
    return run;
  }

  private doSearch(
    sfen: string,
    movetimeMs: number,
    onInfo?: (info: EngineInfo) => void
  ): Promise<EngineSearchResult> {
    return new Promise((resolve, reject) => {
      if (this.status !== "ready") return reject(new Error("engine not ready"));
      const info: EngineInfo = { depth: 0, nodes: 0, scoreCp: null, scoreMate: null, pv: [] };
      const listener = (line: string) => {
        if (line.startsWith("info ") && !line.startsWith("info string")) {
          const d = line.match(/\bdepth (\d+)/);
          if (d) info.depth = parseInt(d[1], 10);
          const n = line.match(/\bnodes (\d+)/);
          if (n) info.nodes = parseInt(n[1], 10);
          const cp = line.match(/\bscore cp (-?\d+)/);
          if (cp) {
            info.scoreCp = parseInt(cp[1], 10);
            info.scoreMate = null;
          }
          const mate = line.match(/\bscore mate (-?\d+)/);
          if (mate) {
            info.scoreMate = parseInt(mate[1], 10);
            info.scoreCp = null;
          }
          const pv = line.match(/\bpv (.+)$/);
          if (pv) info.pv = pv[1].trim().split(/\s+/);
          if (cp || mate || pv) onInfo?.({ ...info, pv: [...info.pv] });
        } else if (line.startsWith("bestmove ")) {
          this.listeners.delete(listener);
          clearTimeout(timer);
          resolve({ ...info, bestmove: line.split(/\s+/)[1] });
        }
      };
      // 探索が固まった場合の保険(movetime + 30秒)
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error("engine search timeout"));
      }, movetimeMs + 30000);
      this.listeners.add(listener);
      this.post(`position sfen ${sfen}`);
      this.post(`go movetime ${movetimeMs}`);
    });
  }

  stop() {
    if (this.status === "ready") this.post("stop");
  }

  terminate() {
    this.module?.terminate();
    this.module = null;
    this.status = "idle";
    this.initPromise = null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

const instances = new Map<EngineVariant, YaneuraOuEngine>();
export function getEngine(variant: EngineVariant): YaneuraOuEngine {
  let e = instances.get(variant);
  if (!e) {
    e = new YaneuraOuEngine(variant);
    instances.set(variant, e);
  }
  return e;
}
