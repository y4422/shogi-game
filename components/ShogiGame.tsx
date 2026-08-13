"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Player, Move, Position,
  FU, KY, KE, GI, KI, KA, HI, OU, TO, NY, NK, NG, UM, RY,
  PROMOTE,
  typeOf, ownerOf, initialPosition, clonePosition,
  makeMove, legalMoves, inCheck, moveToKifu,
  PIECE_KANJI,
} from "@/lib/shogi";
import { searchBestMove, SearchResult, SearchOptions } from "@/lib/ai";
import { positionToSfen, usiToMove } from "@/lib/usi";
import { getEngine, EngineVariant, EngineInfo } from "@/lib/engine";
import styles from "./ShogiGame.module.css";

interface GameSnap {
  board: number[];
  hands: [number[], number[]];
  turn: Player;
}

interface HistoryEntry {
  before: GameSnap;
  move: Move;
  notation: string;
}

type Selection =
  | { kind: "board"; sq: number }
  | { kind: "hand"; piece: number }
  | null;

interface Difficulty {
  label: string;
  js: SearchOptions;
  engine?: { variant: EngineVariant; movetime: number };
}

const DIFFICULTIES: Record<string, Difficulty> = {
  easy: { label: "やさしい", js: { timeMs: 300, maxDepth: 2, noise: 120 } },
  normal: { label: "ふつう", js: { timeMs: 600, maxDepth: 4, noise: 30 } },
  hard: {
    label: "つよい(やねうら王)",
    js: { timeMs: 1500, maxDepth: 8 },
    engine: { variant: "kp", movetime: 600 },
  },
};

interface AiDisplayInfo {
  name: string;
  depth: number;
  nodes: number;
  timeMs: number;
}

// 形勢表示(先手視点の評価値を保持)
interface EvalState {
  senteCp: number | null;
  mate: { side: Player; in: number } | null;
  pvText: string;
}

const HAND_ORDER = [HI, 6, 5, 4, 3, 2, FU]; // 飛角金銀桂香歩

// 駒落ち手合: 上手(=駒を落とす側)が後手側だったときの除去マス
const HANDICAPS: Record<string, { label: string; squares: number[] }> = {
  none: { label: "平手", squares: [] },
  kyo: { label: "香落ち", squares: [8] },
  kaku: { label: "角落ち", squares: [16] },
  hisha: { label: "飛車落ち", squares: [10] },
  hikyo: { label: "飛香落ち", squares: [10, 8] },
  two: { label: "二枚落ち", squares: [10, 16] },
  four: { label: "四枚落ち", squares: [10, 16, 0, 8] },
  six: { label: "六枚落ち", squares: [10, 16, 0, 8, 1, 7] },
  eight: { label: "八枚落ち", squares: [10, 16, 0, 8, 1, 7, 2, 6] },
  ten: { label: "十枚落ち", squares: [10, 16, 0, 8, 1, 7, 2, 6, 3, 5] },
};

// 実物の駒と同じく、種類ごとに大きさへ差をつける(fontはマス比、w/hは%)
const PIECE_METRICS: Record<number, { f: number; w: number; h: number }> = {
  [OU]: { f: 0.56, w: 92, h: 94 },
  [HI]: { f: 0.54, w: 89, h: 92 },
  [KA]: { f: 0.54, w: 89, h: 92 },
  [RY]: { f: 0.54, w: 89, h: 92 },
  [UM]: { f: 0.54, w: 89, h: 92 },
  [KI]: { f: 0.52, w: 86, h: 90 },
  [GI]: { f: 0.52, w: 86, h: 90 },
  [NG]: { f: 0.52, w: 86, h: 90 },
  [KE]: { f: 0.50, w: 83, h: 88 },
  [NK]: { f: 0.50, w: 83, h: 88 },
  [KY]: { f: 0.48, w: 80, h: 87 },
  [NY]: { f: 0.48, w: 80, h: 87 },
  [FU]: { f: 0.46, w: 78, h: 85 },
  [TO]: { f: 0.46, w: 78, h: 85 },
};

function toPos(s: GameSnap): Position {
  return {
    board: Int8Array.from(s.board),
    hands: [Int8Array.from(s.hands[0]), Int8Array.from(s.hands[1])],
    turn: s.turn,
  };
}

function fromPos(p: Position): GameSnap {
  return {
    board: Array.from(p.board),
    hands: [Array.from(p.hands[0]), Array.from(p.hands[1])],
    turn: p.turn,
  };
}

function initialSnap(): GameSnap {
  return fromPos(initialPosition());
}

// 駒落ちの開始局面。AIが上手として駒を落とし、上手が初手を指す
function handicapSnap(h: string, ai: Player): GameSnap {
  const pos = initialPosition();
  const spec = HANDICAPS[h] ?? HANDICAPS.none;
  for (const sq of spec.squares) {
    pos.board[ai === 1 ? sq : 80 - sq] = 0;
  }
  if (spec.squares.length > 0) pos.turn = ai;
  return fromPos(pos);
}

// 千日手判定用キー(盤面+持ち駒+手番)
function repetitionKey(s: GameSnap): string {
  return positionToSfen(toPos(s)).split(" ").slice(0, 3).join(" ");
}

// USI の読み筋を棋譜表記に変換
function pvToKifu(base: Position, pvUsi: string[], limit = 7): string {
  const p = clonePosition(base);
  const parts: string[] = [];
  let prevTo = -1;
  for (const usi of pvUsi.slice(0, limit)) {
    const m = usiToMove(p, usi);
    if (!m) break;
    parts.push(moveToKifu(p, m, prevTo));
    prevTo = m.to;
    makeMove(p, m);
  }
  return parts.join(" ");
}

function judgeText(cp: number): string {
  const a = Math.abs(cp);
  if (a < 100) return "互角";
  const side = cp > 0 ? "あなた" : "AI";
  if (a < 400) return `${side}がやや優勢`;
  if (a < 1200) return `${side}が優勢`;
  return `${side}が勝勢`;
}

const FILE_LABELS = ["9", "8", "7", "6", "5", "4", "3", "2", "1"];
const RANK_LABELS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  width: "1em",
  height: "1em",
  "aria-hidden": true,
} as const;

const IconTrophy = ({ className }: { className?: string }) => (
  <svg {...ICON_PROPS} className={className}>
    <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
    <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
    <path d="M6 2h12v7a6 6 0 0 1-12 0V2Z" />
    <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22h10c0-1.76-.85-3.25-2.03-3.79-.5-.23-.97-.66-.97-1.21v-2.34" />
  </svg>
);

const IconFlag = ({ className }: { className?: string }) => (
  <svg {...ICON_PROPS} className={className}>
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
    <line x1="4" x2="4" y1="22" y2="15" />
  </svg>
);

const IconEqual = ({ className }: { className?: string }) => (
  <svg {...ICON_PROPS} className={className}>
    <line x1="5" x2="19" y1="9" y2="9" />
    <line x1="5" x2="19" y1="15" y2="15" />
  </svg>
);

const IconBulb = ({ className }: { className?: string }) => (
  <svg {...ICON_PROPS} className={className}>
    <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1.3.5 2.6 1.5 3.5.8.8 1.3 1.5 1.5 2.5" />
    <path d="M9 18h6" />
    <path d="M10 22h4" />
  </svg>
);

const IconAlert = ({ className }: { className?: string }) => (
  <svg {...ICON_PROPS} className={className}>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </svg>
);

const IconCheck = ({ className }: { className?: string }) => (
  <svg {...ICON_PROPS} className={className}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

export default function ShogiGame() {
  const [game, setGame] = useState<GameSnap>(initialSnap);
  const [playerColor, setPlayerColor] = useState<Player>(0);
  const [difficulty, setDifficulty] = useState<string>("hard");
  const [handicap, setHandicap] = useState<string>("none");
  const [gameHandicap, setGameHandicap] = useState<string>("none");
  const [confirm, setConfirm] = useState<{
    message: string;
    label: string;
    danger?: boolean;
    action: () => void;
  } | null>(null);
  const [selected, setSelected] = useState<Selection>(null);
  const [pending, setPending] = useState<Move[] | null>(null); // 成り選択待ち
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [thinking, setThinking] = useState(false);
  const [gameOver, setGameOver] = useState<{ winner: Player | "draw"; reason: string } | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [lastMove, setLastMove] = useState<Move | null>(null);
  const [aiInfo, setAiInfo] = useState<AiDisplayInfo | null>(null);
  const [evalState, setEvalState] = useState<EvalState | null>(null);
  const [loadStatus, setLoadStatus] = useState<string | null>(null);
  const [engineNote, setEngineNote] = useState<string | null>(null);
  const [hintMove, setHintMove] = useState<Move | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const kifuRef = useRef<HTMLDivElement>(null);
  const lastInfoAt = useRef(0);

  const aiColor = (1 - playerColor) as Player;
  const flip = playerColor === 1;

  const legal = useMemo(
    () => (gameOver ? [] : legalMoves(toPos(game))),
    [game, gameOver]
  );
  const check = useMemo(() => inCheck(toPos(game)), [game]);

  const applyMove = useCallback((m: Move) => {
    const pos = toPos(game);
    const notation = moveToKifu(pos, m, lastMove?.to ?? -1);
    const mover = game.turn;
    makeMove(pos, m);
    const next = fromPos(pos);
    setHistory(h => [...h, { before: game, move: m, notation }]);
    setLastMove(m);
    setGame(next);
    setSelected(null);
    setPending(null);
    setHintMove(null);
    if (legalMoves(pos).length === 0) {
      setGameOver({ winner: mover, reason: inCheck(pos) ? "詰み" : "指せる手なし" });
      return;
    }
    // 千日手(同一局面4回)
    const key = repetitionKey(next);
    const count = 1 +
      history.filter(e => repetitionKey(e.before) === key).length +
      (repetitionKey(game) === key ? 1 : 0);
    if (count >= 4) {
      setGameOver({ winner: "draw", reason: "千日手" });
    }
  }, [game, lastMove, history]);

  // エンジンの評価値(エンジン手番視点)を先手視点に直して表示用に保存
  const updateEval = useCallback((info: EngineInfo, engineTurn: Player, base: Position) => {
    const now = Date.now();
    if (now - lastInfoAt.current < 250) return; // 描画スロットリング
    lastInfoAt.current = now;
    const sign = engineTurn === 0 ? 1 : -1;
    let senteCp: number | null = null;
    let mate: EvalState["mate"] = null;
    if (info.scoreMate !== null) {
      const winner = info.scoreMate > 0 ? engineTurn : ((1 - engineTurn) as Player);
      mate = { side: winner, in: Math.abs(info.scoreMate) };
    } else if (info.scoreCp !== null) {
      senteCp = info.scoreCp * sign;
    }
    setEvalState({
      senteCp,
      mate,
      pvText: info.pv.length ? pvToKifu(base, info.pv) : "",
    });
  }, []);

  // AI の手番になったら探索を開始
  useEffect(() => {
    if (gameOver || game.turn !== aiColor) return;
    let cancelled = false;
    setThinking(true);
    const diff = DIFFICULTIES[difficulty];

    const finish = (m: Move | null, info: AiDisplayInfo | null) => {
      if (cancelled) return;
      setThinking(false);
      setLoadStatus(null);
      if (info) setAiInfo(info);
      if (m) applyMove(m);
    };

    const runJs = () => {
      const opts = diff.js;
      const handleJsResult = (r: SearchResult) => {
        const sign = aiColor === 0 ? 1 : -1;
        setEvalState({ senteCp: r.score * sign, mate: null, pvText: "" });
        finish(r.move, { name: "内蔵JS探索", depth: r.depth, nodes: r.nodes, timeMs: r.timeMs });
      };
      const fallbackSync = () => {
        setTimeout(() => handleJsResult(searchBestMove(toPos(game), opts)), 60);
      };
      try {
        if (!workerRef.current) {
          workerRef.current = new Worker(new URL("../lib/ai.worker.ts", import.meta.url));
        }
        const w = workerRef.current;
        w.onmessage = (e: MessageEvent<SearchResult>) => handleJsResult(e.data);
        w.onerror = () => {
          workerRef.current?.terminate();
          workerRef.current = null;
          fallbackSync();
        };
        w.postMessage({ board: game.board, hands: game.hands, turn: game.turn, opts });
      } catch {
        fallbackSync();
      }
    };

    const runEngine = async () => {
      const spec = diff.engine!;
      const base = toPos(game);
      // メイン → フォールバックの順に初期化を試す
      let eng = getEngine(spec.variant);
      eng.onProgress = (phase, pct) => {
        if (cancelled) return;
        if (phase === "init") {
          setLoadStatus("エンジン初期化中…");
        } else {
          setLoadStatus("エンジン読み込み中…");
        }
      };
      let ok = await eng.init();
      if (cancelled) return;
      if (!ok) {
        setEngineNote("エンジンを起動できないため、内蔵JS探索で代用します(SharedArrayBuffer 非対応環境?)");
        runJs();
        return;
      }
      setLoadStatus(null);
      const t0 = Date.now();
      try {
        const res = await eng.search(
          positionToSfen(base),
          spec.movetime,
          info => { if (!cancelled) updateEval(info, aiColor, base); }
        );
        if (cancelled) return;
        if (res.bestmove === "resign") {
          setThinking(false);
          setGameOver({ winner: playerColor, reason: "AI投了" });
          return;
        }
        if (res.bestmove === "win") {
          setThinking(false);
          setGameOver({ winner: aiColor, reason: "入玉宣言" });
          return;
        }
        const m = usiToMove(toPos(game), res.bestmove);
        if (!m) {
          runJs();
          return;
        }
        lastInfoAt.current = 0;
        updateEval(res, aiColor, base);
        finish(m, {
          name: eng.displayName,
          depth: res.depth,
          nodes: res.nodes,
          timeMs: Date.now() - t0,
        });
      } catch {
        if (!cancelled) runJs();
      }
    };

    if (diff.engine) {
      runEngine();
      return () => {
        cancelled = true;
        getEngine(diff.engine!.variant).stop();
      };
    }

    runJs();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, gameOver, aiColor, difficulty]);

  // 対応レベル選択時はエンジンを先読みロード
  useEffect(() => {
    const spec = DIFFICULTIES[difficulty].engine;
    if (spec) getEngine(spec.variant).init();
  }, [difficulty]);

  useEffect(() => () => workerRef.current?.terminate(), []);

  useEffect(() => {
    kifuRef.current?.scrollTo({ top: kifuRef.current.scrollHeight });
  }, [history]);

  // 決着したら結果ダイアログを開く
  useEffect(() => {
    if (gameOver) setResultOpen(true);
  }, [gameOver]);

  const playerTurn = !gameOver && !thinking && game.turn === playerColor;

  // 選択中の駒から行ける先
  const dests = useMemo(() => {
    if (!selected || !playerTurn) return new Map<number, Move[]>();
    const map = new Map<number, Move[]>();
    for (const m of legal) {
      const match = selected.kind === "board"
        ? m.from === selected.sq
        : m.from === -1 && m.drop === selected.piece;
      if (!match) continue;
      const arr = map.get(m.to) ?? [];
      arr.push(m);
      map.set(m.to, arr);
    }
    return map;
  }, [selected, legal, playerTurn]);

  const onCellClick = (idx: number) => {
    if (!playerTurn || pending) return;
    const options = dests.get(idx);
    if (options && options.length > 0) {
      if (options.length > 1) setPending(options); // 成る/成らず
      else applyMove(options[0]);
      return;
    }
    const p = game.board[idx];
    if (p && ownerOf(p) === playerColor) {
      setSelected({ kind: "board", sq: idx });
    } else {
      setSelected(null);
    }
  };

  const onHandClick = (owner: Player, piece: number) => {
    if (!playerTurn || pending || owner !== playerColor) return;
    if (game.hands[playerColor][piece] <= 0) return;
    setSelected(prev =>
      prev?.kind === "hand" && prev.piece === piece ? null : { kind: "hand", piece }
    );
  };

  const restart = (color: Player, h: string = handicap) => {
    workerRef.current?.terminate();
    workerRef.current = null;
    getEngine("kp").stop();
    getEngine("kp").newGame();
    setGame(handicapSnap(h, (1 - color) as Player));
    setGameHandicap(h);
    setPlayerColor(color);
    setConfirm(null);
    setHistory([]);
    setGameOver(null);
    setResultOpen(false);
    setSelected(null);
    setPending(null);
    setLastMove(null);
    setAiInfo(null);
    setEvalState(null);
    setHintMove(null);
    setThinking(false);
  };

  const undo = () => {
    if (thinking || history.length === 0) return;
    const h = [...history];
    let snap: GameSnap | null = null;
    while (h.length > 0) {
      const e = h.pop()!;
      snap = e.before;
      if (snap.turn === playerColor) break;
    }
    if (!snap) return;
    setGame(snap);
    setHistory(h);
    setGameOver(null);
    setResultOpen(false);
    setSelected(null);
    setPending(null);
    setHintMove(null);
    setLastMove(h.length > 0 ? h[h.length - 1].move : null);
  };

  const resign = () => {
    if (gameOver) return;
    setGameOver({ winner: aiColor, reason: "投了" });
    setSelected(null);
    setPending(null);
  };

  const gameInProgress = history.length > 0 && !gameOver;

  // 対局が進行中なら、破壊的な操作の前に確認を挟む
  const requestRestart = (color: Player) => {
    if (gameInProgress) {
      setConfirm({
        message: "対局中です。中断して新しい対局を始めますか?",
        label: color === 0 ? "先手で対局" : "後手で対局",
        action: () => restart(color),
      });
    } else {
      restart(color);
    }
  };

  const requestResign = () => {
    if (gameOver) return;
    setConfirm({
      message: "投了しますか?",
      label: "投了する",
      danger: true,
      action: resign,
    });
  };

  // 手合変更: 対局前なら即反映、対局中は次の対局から
  const onHandicapChange = (v: string) => {
    setHandicap(v);
    if (!gameInProgress) restart(playerColor, v);
  };

  // ヒント: 高速エンジン(なければJS)に現局面の最善手を聞く
  const hint = async () => {
    if (!playerTurn || hintBusy) return;
    setHintBusy(true);
    try {
      const base = toPos(game);
      const eng = getEngine("kp");
      const ok = await eng.init();
      let m: Move | null = null;
      if (ok) {
        const res = await eng.search(positionToSfen(base), 800);
        m = usiToMove(base, res.bestmove);
      } else {
        const res = searchBestMove(base, { timeMs: 800, maxDepth: 6 });
        m = res.move;
      }
      setHintMove(m);
    } finally {
      setHintBusy(false);
    }
  };

  const copyKifu = async () => {
    const text = history.map((e, i) => `${i + 1} ${e.notation}`).join("\n") || "(棋譜なし)";
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard API 不可の環境向けフォールバック
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { /* 諦める */ }
      ta.remove();
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const renderPiece = (t: number, extraClass = "", glyph?: string) => {
    const m = PIECE_METRICS[t] ?? { f: 0.5, w: 85, h: 89 };
    return (
      <span
        className={`${styles.piece} ${t >= 9 ? styles.promoted : ""} ${extraClass}`}
        style={{
          fontSize: `calc(var(--cell) * ${m.f})`,
          width: `${m.w}%`,
          height: `${m.h}%`,
        }}
      >
        {glyph ?? PIECE_KANJI[t]}
      </span>
    );
  };

  const renderHand = (owner: Player) => {
    const hand = game.hands[owner];
    const isPlayer = owner === playerColor;
    const active = !gameOver && game.turn === owner;
    return (
      <div
        className={`${styles.hand} ${isPlayer ? styles.handMine : styles.handOpp} ${active ? styles.handActive : ""}`}
      >
        <span className={`${styles.handLabel} ${isPlayer ? styles.handLabelYou : styles.handLabelAi}`}>
          <span className={styles.handMark}>{(owner === 0) !== flip ? "☗" : "☖"}</span>
          {isPlayer ? "あなた" : "AI"}
        </span>
        <div className={styles.handPieces}>
          {HAND_ORDER.filter(t => hand[t] > 0).map(t => (
            <button
              key={t}
              className={`${styles.handPiece} ${
                selected?.kind === "hand" && selected.piece === t && isPlayer
                  ? styles.selectedPiece : ""
              }`}
              onClick={() => onHandClick(owner, t)}
              aria-label={`持ち駒 ${PIECE_KANJI[t]} ${hand[t]}枚`}
            >
              {PIECE_KANJI[t]}
              {hand[t] > 1 && <span className={styles.handCount}>{hand[t]}</span>}
            </button>
          ))}
          {HAND_ORDER.every(t => hand[t] === 0) && (
            <span className={styles.handNone}>持ち駒なし</span>
          )}
        </div>
      </div>
    );
  };

  const files = flip ? [...FILE_LABELS].reverse() : FILE_LABELS;
  const ranks = flip ? [...RANK_LABELS].reverse() : RANK_LABELS;

  const statusText = gameOver
    ? gameOver.winner === "draw"
      ? `引き分け(${gameOver.reason})`
      : gameOver.winner === playerColor
        ? `あなたの勝ち!(${gameOver.reason})`
        : `AIの勝ち(${gameOver.reason})`
    : thinking
      ? loadStatus ?? "AIが考えています…"
      : check
        ? "王手!あなたの番です"
        : game.turn === playerColor
          ? "あなたの番です"
          : "AIの番です";

  // 形勢バー: プレイヤー視点の勝率
  const playerCp = evalState?.senteCp != null
    ? (playerColor === 0 ? evalState.senteCp : -evalState.senteCp)
    : evalState?.mate
      ? (evalState.mate.side === playerColor ? 30000 : -30000)
      : null;
  const playerPct = playerCp != null ? Math.round(100 / (1 + Math.exp(-playerCp / 600))) : 50;
  const evalText = evalState?.mate
    ? `${evalState.mate.in}手詰み(${evalState.mate.side === playerColor ? "あなたの勝ち筋" : "AIの勝ち筋"})`
    : playerCp != null
      ? `${judgeText(playerCp)}(${playerCp > 0 ? "+" : ""}${playerCp})`
      : "形勢 互角";

  const pendingBase = pending ? typeOf(game.board[pending[0].from]) : 0;

  return (
    <div className={styles.wrap}>
      <div className={styles.boardCol}>
        <div
          className={`${styles.status} ${
            gameOver
              ? gameOver.winner === playerColor ? styles.statusWin : styles.statusLose
              : thinking ? styles.statusThinking
                : check ? styles.statusCheck : styles.statusYou
          }`}
          role="status"
        >
          {gameOver && gameOver.winner === playerColor && (
            <IconTrophy className={styles.inlineIcon} />
          )}
          {statusText}
          {thinking && <span className={styles.spinner} />}
        </div>

        <div className={styles.evalRow} title="形勢(あなた視点)">
          <span className={styles.evalLabelYou}>あなた</span>
          <div className={styles.evalBar}>
            <div className={styles.evalFill} style={{ width: `${playerPct}%` }} />
            <span className={styles.evalCenter} />
          </div>
          <span className={styles.evalLabelAi}>AI</span>
          <span className={styles.evalText}>{evalText}</span>
        </div>

        {renderHand(aiColor)}

        <div className={styles.boardArea}>
          <div className={styles.fileLabels}>
            {files.map(f => <span key={f}>{f}</span>)}
          </div>
          <div className={styles.boardRow}>
            <div className={styles.boardFrame}>
              <div className={styles.board}>
                {Array.from({ length: 81 }, (_, vi) => {
                  const vr = (vi / 9) | 0, vc = vi % 9;
                  const idx = flip ? (8 - vr) * 9 + (8 - vc) : vr * 9 + vc;
                  const p = game.board[idx];
                  const isDest = dests.has(idx);
                  const isSel = selected?.kind === "board" && selected.sq === idx;
                  const isLast = lastMove?.to === idx || (lastMove?.from ?? -2) === idx;
                  const isHint = hintMove !== null && (hintMove.to === idx || hintMove.from === idx);
                  return (
                    <div
                      key={vi}
                      className={`${styles.cell} ${isLast ? styles.lastMove : ""} ${isDest ? styles.dest : ""} ${isSel ? styles.selCell : ""} ${isHint ? styles.hintCell : ""}`}
                      onClick={() => onCellClick(idx)}
                    >
                      {p !== 0 && (
                        <span
                          className={`${styles.pieceSlot} ${ownerOf(p) !== playerColor ? styles.enemy : ""}`}
                        >
                          {renderPiece(
                            typeOf(p),
                            isSel ? styles.selectedPiece : "",
                            typeOf(p) === OU
                              ? (ownerOf(p) === 1 ? "王" : "玉")
                              : undefined
                          )}
                        </span>
                      )}
                      {isDest && p === 0 && <span className={styles.dot} />}
                    </div>
                  );
                })}
                <span className={`${styles.hoshi} ${styles.hoshiTL}`} aria-hidden />
                <span className={`${styles.hoshi} ${styles.hoshiTR}`} aria-hidden />
                <span className={`${styles.hoshi} ${styles.hoshiBL}`} aria-hidden />
                <span className={`${styles.hoshi} ${styles.hoshiBR}`} aria-hidden />
              </div>
            </div>
            <div className={styles.rankLabels}>
              {ranks.map(r => <span key={r}>{r}</span>)}
            </div>
          </div>
        </div>

        {renderHand(playerColor)}

        {hintMove && (
          <div className={styles.hintText}>
            <IconBulb className={styles.inlineIcon} />
            ヒント: {moveToKifu(toPos(game), hintMove, lastMove?.to ?? -1)}
          </div>
        )}
        {engineNote && (
          <div className={styles.engineWarn}>
            <IconAlert className={styles.inlineIcon} /> {engineNote}
          </div>
        )}
      </div>

      <div className={styles.side}>
        <div className={styles.controls}>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => requestRestart(0)}>
            <span className={styles.btnMark}>☗</span>先手で対局
          </button>
          <button className={styles.btn} onClick={() => requestRestart(1)}>
            <span className={styles.btnMark}>☖</span>後手で対局
          </button>
          <button className={styles.btn} onClick={undo} disabled={thinking || history.length === 0}>
            待った
          </button>
          <button className={styles.btn} onClick={hint} disabled={!playerTurn || hintBusy}>
            {hintBusy ? "考え中…" : "ヒント"}
          </button>
          <button className={`${styles.btn} ${styles.btnDanger}`} onClick={requestResign} disabled={!!gameOver}>
            投了
          </button>
          <label className={styles.diffLabel}>
            <span>強さ</span>
            <select value={difficulty} onChange={e => setDifficulty(e.target.value)}>
              {Object.entries(DIFFICULTIES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          <label className={styles.diffLabel}>
            <span>手合</span>
            <select value={handicap} onChange={e => onHandicapChange(e.target.value)}>
              {Object.entries(HANDICAPS).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </label>
          {handicap !== gameHandicap && gameInProgress && (
            <div className={styles.handicapNote}>
              手合「{HANDICAPS[handicap].label}」は次の対局から適用されます
            </div>
          )}
        </div>

        <div className={styles.kifuPane}>
          <div className={styles.kifuHeader}>
            <h2>
              棋譜{" "}
              <span className={styles.kifuCount}>
                {history.length}手
                {gameHandicap !== "none" && `・${HANDICAPS[gameHandicap].label}`}
              </span>
            </h2>
            <button className={styles.copyBtn} onClick={copyKifu}>
              {copied ? (
                <>
                  <IconCheck className={styles.inlineIcon} /> コピーしました
                </>
              ) : (
                "コピー"
              )}
            </button>
          </div>
          <div className={styles.kifu} ref={kifuRef}>
            {history.length === 0 && <div className={styles.kifuEmpty}>まだ指し手はありません</div>}
            {history.map((e, i) => (
              <div
                key={i}
                className={`${styles.kifuLine} ${i === history.length - 1 ? styles.kifuLatest : ""}`}
              >
                <span className={styles.kifuNum}>{i + 1}</span>
                <span className={styles.kifuMark}>{e.before.turn === 0 ? "☗" : "☖"}</span>
                {e.notation}
              </div>
            ))}
          </div>
          {evalState?.pvText && (
            <div className={styles.pvBox}>
              <h3>AIの読み筋</h3>
              <div className={styles.pvText}>{evalState.pvText}</div>
            </div>
          )}
        </div>

        {aiInfo && (
          <div className={styles.aiInfo}>
            {aiInfo.name}: 深さ{aiInfo.depth} / {aiInfo.nodes.toLocaleString()}局面 /{" "}
            {(aiInfo.timeMs / 1000).toFixed(1)}秒
          </div>
        )}
      </div>

      {confirm && (
        <div className={styles.overlay} onClick={() => setConfirm(null)}>
          <div className={styles.dialog} onClick={e => e.stopPropagation()}>
            <p className={styles.dialogTitle}>{confirm.message}</p>
            <div className={styles.confirmButtons}>
              <button className={styles.btn} onClick={() => setConfirm(null)}>
                やめる
              </button>
              <button
                className={`${styles.btn} ${confirm.danger ? styles.btnDangerSolid : styles.btnPrimary}`}
                onClick={() => {
                  const a = confirm.action;
                  setConfirm(null);
                  a();
                }}
              >
                {confirm.label}
              </button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <div className={styles.overlay}>
          <div className={styles.dialog}>
            <p className={styles.dialogTitle}>成りますか?</p>
            <div className={styles.promoChoices}>
              <button
                className={styles.promoChoice}
                onClick={() => applyMove(pending.find(m => m.promote)!)}
              >
                <span className={`${styles.promoPiece} ${styles.promoted}`}>
                  {PIECE_KANJI[PROMOTE[pendingBase]]}
                </span>
                成る
              </button>
              <button
                className={styles.promoChoice}
                onClick={() => applyMove(pending.find(m => !m.promote)!)}
              >
                <span className={styles.promoPiece}>{PIECE_KANJI[pendingBase]}</span>
                成らず
              </button>
            </div>
          </div>
        </div>
      )}

      {gameOver && resultOpen && (
        <div className={styles.overlay} onClick={() => setResultOpen(false)}>
          <div className={styles.dialog} onClick={e => e.stopPropagation()}>
            <p
              className={`${styles.resultIcon} ${
                gameOver.winner === "draw"
                  ? styles.resultIconDraw
                  : gameOver.winner === playerColor
                    ? styles.resultIconWin
                    : styles.resultIconLose
              }`}
              aria-hidden
            >
              {gameOver.winner === "draw"
                ? <IconEqual />
                : gameOver.winner === playerColor
                  ? <IconTrophy />
                  : <IconFlag />}
            </p>
            <p className={`${styles.resultTitle} ${
              gameOver.winner === playerColor ? styles.win : gameOver.winner === "draw" ? "" : styles.lose
            }`}>
              {gameOver.winner === "draw"
                ? "引き分け"
                : gameOver.winner === playerColor
                  ? "あなたの勝ち!"
                  : "AIの勝ち"}
            </p>
            <p className={styles.resultReason}>{gameOver.reason} — {history.length}手</p>
            <div className={styles.resultButtons}>
              <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => restart(0)}>
                <span className={styles.btnMark}>☗</span>先手で再戦
              </button>
              <button className={styles.btn} onClick={() => restart(1)}>
                <span className={styles.btnMark}>☖</span>後手で再戦
              </button>
            </div>
            <button className={styles.resultClose} onClick={() => setResultOpen(false)}>
              盤面を見る
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
