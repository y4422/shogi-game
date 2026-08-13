"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Player, Move, Position,
  FU, KY, KE, GI, KI, KA, HI, OU, TO, NY, NK, NG, UM, RY,
  PROMOTE,
  typeOf, ownerOf, initialPosition, clonePosition,
  makeMove, legalMoves, inCheck, moveToKifu, sameMove, attackCounts,
  PIECE_KANJI, KIFU_KANJI, squareName,
} from "@/lib/shogi";
import { searchBestMove, SearchResult, SearchOptions } from "@/lib/ai";
import { positionToSfen, usiToMove, moveToUsi } from "@/lib/usi";
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

// ---- コーチモード ----

type Grade = "best" | "good" | "ok" | "dubious" | "bad" | "blunder";

const GRADE_INFO: Record<Grade, { label: string; order: number }> = {
  best: { label: "最善", order: 0 },
  good: { label: "好手", order: 1 },
  ok: { label: "まずまず", order: 2 },
  dubious: { label: "疑問手", order: 3 },
  bad: { label: "悪手", order: 4 },
  blunder: { label: "大悪手", order: 5 },
};

const initialGradeCounts = (): Record<Grade, number> =>
  ({ best: 0, good: 0, ok: 0, dubious: 0, bad: 0, blunder: 0 });

// 詰みを含む評価値を ±32000 に収めた「プレイヤー視点」スコア
const clampScore = (s: number) => Math.max(-32000, Math.min(32000, s));

interface CoachSearch {
  sfen: string; // 探索した局面(手番=プレイヤー)
  move: Move | null;
  score: number; // プレイヤー視点
  mate: boolean; // プレイヤーに詰みがある
  pv: string[]; // USI
}

interface PendingJudge {
  pre: CoachSearch;
  playedMove: Move;
  playedNotation: string;
  baseSnap: GameSnap; // プレイヤーが指す直前の局面
  prevTo: number; // 「同」表記用
  ply: number; // この手が何手目か
}

interface PvPreview {
  snaps: GameSnap[];
  moves: Move[];
  notations: string[];
  idx: number;
}

interface CoachAdvice {
  grade: Grade;
  text: string;
  reason: string | null;
  pvText: string;
  preview: Omit<PvPreview, "idx"> | null;
  bestMove: Move | null;
  bestNotation: string;
  baseSnap: GameSnap;
}

// 読み筋を盤上再生できる形に展開(最大5手)
function buildPvPreview(
  baseSnap: GameSnap, pvUsi: string[], prevTo: number
): Omit<PvPreview, "idx"> | null {
  const p = toPos(baseSnap);
  const snaps: GameSnap[] = [baseSnap];
  const moves: Move[] = [];
  const notations: string[] = [];
  let pt = prevTo;
  for (const usi of pvUsi.slice(0, 5)) {
    const m = usiToMove(p, usi);
    if (!m) break;
    notations.push(moveToKifu(p, m, pt));
    pt = m.to;
    makeMove(p, m);
    moves.push(m);
    snaps.push(fromPos(p));
  }
  return moves.length > 0 ? { snaps, moves, notations } : null;
}

// おすすめ手の「理由」をルールから機械的に説明
function moveReason(baseSnap: GameSnap, m: Move): string | null {
  const pos = toPos(baseSnap);
  const target = pos.board[m.to];
  const clone = clonePosition(pos);
  makeMove(clone, m);
  const givesCheck = inCheck(clone);
  if (target) return `${KIFU_KANJI[typeOf(target)]}を取れる手です`;
  if (givesCheck) return "王手をかける手です";
  if (m.promote) return "駒が成って強くなる手です";
  if (m.from === -1) return "持ち駒を活用する手です";
  return null;
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
  const [coachOn, setCoachOn] = useState(true);
  const [showEffects, setShowEffects] = useState(false);
  const [advice, setAdvice] = useState<CoachAdvice | null>(null);
  const [preview, setPreview] = useState<PvPreview | null>(null);
  const [replayPly, setReplayPly] = useState<number | null>(null); // 棋譜のこの手数を盤に表示中
  const [hoverPly, setHoverPly] = useState<number | null>(null); // グラフのホバー位置
  const [gradeCounts, setGradeCounts] = useState<Record<Grade, number>>(initialGradeCounts);
  const [evalByPly, setEvalByPly] = useState<Record<number, number>>({}); // 先手視点cp
  const [gradeByPly, setGradeByPly] = useState<Record<number, Grade>>({});
  const workerRef = useRef<Worker | null>(null);
  const kifuRef = useRef<HTMLDivElement>(null);
  const lastInfoAt = useRef(0);
  const gameRef = useRef(game);
  gameRef.current = game;
  const historyRef = useRef(history);
  historyRef.current = history;
  const preSearchRef = useRef<CoachSearch | null>(null);
  const coachSessionRef = useRef(0); // 待った/再対局で古い判定を無効化する世代カウンタ
  const coachWorkerRef = useRef<Worker | null>(null);
  const coachChainRef = useRef<Promise<unknown>>(Promise.resolve());

  // コーチ・利き表示の設定を保存・復元
  useEffect(() => {
    const saved = localStorage.getItem("shogi-coach");
    if (saved !== null) setCoachOn(saved !== "0");
    setShowEffects(localStorage.getItem("shogi-effects") === "1");
  }, []);
  const toggleEffects = () => {
    setShowEffects(v => {
      localStorage.setItem("shogi-effects", v ? "0" : "1");
      return !v;
    });
  };

  // 形勢の記録(グラフ用、先手視点)
  const recordEval = useCallback((ply: number, senteCp: number) => {
    setEvalByPly(m => ({ ...m, [ply]: clampScore(senteCp) }));
  }, []);
  const toggleCoach = () => {
    setCoachOn(v => {
      localStorage.setItem("shogi-coach", v ? "0" : "1");
      if (v) {
        setAdvice(null);
        setPreview(null);
        coachSessionRef.current++;
      }
      return !v;
    });
  };

  // エンジンが使えない環境用: コーチ専用のJS探索ワーカー(直列化して使い回す)
  const coachJsSearch = useCallback((snap: GameSnap, timeMs: number) => {
    const run = coachChainRef.current.then(
      () => new Promise<SearchResult>((resolve, reject) => {
        try {
          if (!coachWorkerRef.current) {
            coachWorkerRef.current = new Worker(new URL("../lib/ai.worker.ts", import.meta.url));
          }
          const w = coachWorkerRef.current;
          w.onmessage = (e: MessageEvent<SearchResult>) => resolve(e.data);
          w.onerror = () => {
            coachWorkerRef.current?.terminate();
            coachWorkerRef.current = null;
            reject(new Error("coach worker error"));
          };
          w.postMessage({
            board: snap.board, hands: snap.hands, turn: snap.turn,
            opts: { timeMs, maxDepth: 6 },
          });
        } catch (e) {
          reject(e);
        }
      })
    );
    coachChainRef.current = run.catch(() => {});
    return run;
  }, []);
  useEffect(() => () => coachWorkerRef.current?.terminate(), []);

  // 局面をプレイヤー視点で評価(エンジン優先。失敗時はJSワーカーへフォールバック)
  const coachEvaluate = useCallback(async (
    snap: GameSnap, timeMs: number
  ): Promise<CoachSearch | null> => {
    const base = toPos(snap);
    const sfen = positionToSfen(base);
    const eng = getEngine("kp");
    const ok = await eng.init();
    if (ok) {
      try {
        const res = await eng.search(sfen, timeMs);
        const m = usiToMove(base, res.bestmove);
        // 評価が取れない(探索が中断された等)ときはJS探索へ落とす
        if (m && (res.scoreCp !== null || res.scoreMate !== null)) {
          let score: number;
          let mateForMover = false;
          if (res.scoreMate !== null) {
            mateForMover = res.scoreMate > 0;
            score = res.scoreMate > 0
              ? 32000 - Math.abs(res.scoreMate)
              : -32000 + Math.abs(res.scoreMate);
          } else {
            score = clampScore(res.scoreCp!);
          }
          return { sfen, move: m, score, mate: mateForMover, pv: res.pv };
        }
      } catch {
        // フォールバックへ
      }
    }
    try {
      const r = await coachJsSearch(snap, timeMs);
      return {
        sfen,
        move: r.move,
        score: clampScore(r.score),
        mate: r.score > 90_000,
        pv: r.move ? [moveToUsi(r.move)] : [],
      };
    } catch {
      return null;
    }
  }, [coachJsSearch]);

  // プレイヤーの指した手を判定して助言カードを出す(AIの応答と並行して進む)
  const judgePlayed = useCallback((pj: PendingJudge, next: GameSnap) => {
    const sess = coachSessionRef.current;
    (async () => {
      const post = await coachEvaluate(next, 400);
      if (!post || coachSessionRef.current !== sess) return;
      const playedScore = -post.score; // 手番(相手)視点 → プレイヤー視点
      const { pre, playedMove, playedNotation, baseSnap, prevTo, ply } = pj;
      const basePos = toPos(baseSnap);
      const isBest = pre.move !== null && sameMove(pre.move, playedMove);
      const loss = Math.max(0, pre.score - playedScore);
      const grade: Grade =
        isBest || loss <= 30 ? "best"
          : loss <= 100 ? "good"
            : loss <= 250 ? "ok"
              : loss <= 600 ? "dubious"
                : loss <= 1200 ? "bad" : "blunder";
      // 指した手番(=プレイヤー)視点 → 先手視点にしてグラフへ記録
      recordEval(ply, baseSnap.turn === 0 ? playedScore : -playedScore);
      setGradeByPly(m => ({ ...m, [ply]: grade }));
      setGradeCounts(c => ({ ...c, [grade]: c[grade] + 1 }));
      if (grade === "ok") return;

      const bestNotation = pre.move ? moveToKifu(basePos, pre.move, prevTo) : "";
      // 読み筋は「最善手を指した(=この先の展開)」か「指導(=おすすめ手の展開)」のときだけ。
      // 好手どまりの手に別の手の読み筋を添えると紛らわしい
      const showPv = isBest || grade === "dubious" || grade === "bad" || grade === "blunder";
      const pvPreview = showPv && pre.pv.length > 0
        ? buildPvPreview(baseSnap, pre.pv, prevTo) : null;
      const reason = pre.move && grade !== "best" && grade !== "good"
        ? moveReason(baseSnap, pre.move) : null;
      let text: string;
      if (grade === "best") {
        text = "最善手！すばらしい読みです";
      } else if (grade === "good") {
        text = "いい手です！";
      } else if (grade === "blunder" && pre.mate) {
        text = `実はここ、${bestNotation}から詰みがありました！`;
      } else if (grade === "blunder" || grade === "bad") {
        text = `${playedNotation}は損だったかも。おすすめは${bestNotation}でした`;
      } else {
        text = `悪くない手ですが、${bestNotation}ならもっと良かったようです`;
      }
      setAdvice({
        grade,
        text,
        reason,
        pvText: pvPreview ? pvPreview.notations.join(" ") : "",
        preview: pvPreview,
        bestMove: pre.move,
        bestNotation,
        baseSnap,
      });
    })();
  }, [coachEvaluate, recordEval]);

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
    // コーチ: 事前探索と同じ局面からプレイヤーが指したなら判定対象にする
    let pj: PendingJudge | null = null;
    if (coachOn && mover === playerColor) {
      const pre = preSearchRef.current;
      if (pre && pre.sfen === positionToSfen(pos)) {
        pj = {
          pre,
          playedMove: m,
          playedNotation: notation,
          baseSnap: game,
          prevTo: lastMove?.to ?? -1,
          ply: history.length + 1,
        };
      }
    }
    makeMove(pos, m);
    const next = fromPos(pos);
    setHistory(h => [...h, { before: game, move: m, notation }]);
    setLastMove(m);
    setGame(next);
    setSelected(null);
    setPending(null);
    setHintMove(null);
    // 助言は「自分が次を指すまで」残す(AIの応手では消さない)
    if (mover === playerColor) {
      setAdvice(null);
      setPreview(null);
    }
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
      return;
    }
    if (pj) judgePlayed(pj, next);
  }, [game, lastMove, history, coachOn, playerColor, judgePlayed]);

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
        const senteCp = clampScore(r.score) * sign;
        setEvalState({ senteCp, mate: null, pvText: "" });
        if (r.move) recordEval(historyRef.current.length + 1, senteCp);
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
        {
          // グラフ用に先手視点で記録(詰みは±上限に丸める)
          const sign = aiColor === 0 ? 1 : -1;
          const senteCp = res.scoreMate !== null
            ? (res.scoreMate > 0 ? 1 : -1) * sign * 30000
            : (res.scoreCp ?? 0) * sign;
          recordEval(historyRef.current.length + 1, senteCp);
        }
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

  // コーチ: プレイヤーの手番中に最善手を先読みしておく(エンジンは空いている)
  useEffect(() => {
    if (!coachOn || gameOver || thinking || game.turn !== playerColor) return;
    let cancelled = false;
    let running = true;
    const snap = game;
    (async () => {
      const res = await coachEvaluate(snap, 500);
      running = false;
      if (!cancelled && res) preSearchRef.current = res;
    })();
    return () => {
      cancelled = true;
      // 事前探索がまだ走っているときだけ止める。無条件に stop すると、
      // 直後に始まるコーチの事後評価やAIの探索まで殺してしまう
      if (running) getEngine("kp").stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, gameOver, thinking, playerColor, coachOn]);


  // Esc でダイアログ・選択を閉じる
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setConfirm(null);
      setResultOpen(false);
      setPending(null);
      setSelected(null);
      setPreview(null);
      setReplayPly(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // 読み筋プレビューの操作
  const openPreview = () => {
    if (!advice?.preview) return;
    setSelected(null);
    setReplayPly(null);
    setPreview({ ...advice.preview, idx: 1 });
  };
  const closePreview = () => setPreview(null);
  const stepPreview = (d: number) => {
    setPreview(p => {
      if (!p) return p;
      const idx = Math.max(0, Math.min(p.snaps.length - 1, p.idx + d));
      return { ...p, idx };
    });
  };

  // 感想戦: 棋譜の任意の手を盤に表示
  const openReplay = (ply: number) => {
    if (history.length === 0) return;
    setPreview(null);
    setSelected(null);
    setReplayPly(Math.max(0, Math.min(history.length, ply)));
  };
  const stepReplay = (d: number) => {
    setReplayPly(p =>
      p === null ? p : Math.max(0, Math.min(history.length, p + d))
    );
  };
  const closeReplay = () => setReplayPly(null);

  // 「試してみる」= 待ったで戻り、おすすめ手をハイライト
  const tryBest = () => {
    if (!advice || thinking) return;
    const best = advice.bestMove;
    undo();
    setHintMove(best);
  };

  const boardLocked = preview !== null || replayPly !== null;

  const onCellClick = (idx: number) => {
    if (boardLocked) return;
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
    if (boardLocked) return;
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
    setAdvice(null);
    setPreview(null);
    setReplayPly(null);
    setHoverPly(null);
    setGradeCounts(initialGradeCounts());
    setEvalByPly({});
    setGradeByPly({});
    preSearchRef.current = null;
    coachSessionRef.current++;
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
    setAdvice(null);
    setPreview(null);
    setReplayPly(null);
    setHoverPly(null);
    coachSessionRef.current++;
    // 巻き戻した先より後の記録は破棄
    const keep = (rec: Record<number, number> | Record<number, Grade>) =>
      Object.fromEntries(Object.entries(rec).filter(([k]) => Number(k) <= h.length));
    setEvalByPly(m => keep(m) as Record<number, number>);
    setGradeByPly(m => keep(m) as Record<number, Grade>);
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
      const baseSfen = positionToSfen(base);
      const eng = getEngine("kp");
      const ok = await eng.init();
      let m: Move | null = null;
      if (ok) {
        const res = await eng.search(baseSfen, 800);
        m = usiToMove(base, res.bestmove);
      } else {
        const res = searchBestMove(base, { timeMs: 800, maxDepth: 6 });
        m = res.move;
      }
      // 探索中に局面が変わっていたら(先に指した・投了・再対局など)捨てる
      if (positionToSfen(toPos(gameRef.current)) === baseSfen) setHintMove(m);
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

  // プレビュー/感想戦中はその局面を表示する
  const replaySnap = replayPly === null
    ? null
    : replayPly >= history.length ? game : history[replayPly].before;
  const view = preview ? preview.snaps[preview.idx] : replaySnap ?? game;
  const overrideMove = preview
    ? (preview.idx > 0 ? preview.moves[preview.idx - 1] : null)
    : replayPly !== null
      ? (replayPly > 0 ? history[replayPly - 1].move : null)
      : null;

  // 利き表示: 表示中の盤面に対する両者の利き数
  const effectCounts = useMemo(
    () => (showEffects ? attackCounts(Int8Array.from(view.board)) : null),
    [showEffects, view]
  );

  // 形勢グラフ用の点列(先手視点 → プレイヤー視点に変換して描画)
  const evalPoints = useMemo(() => {
    const pts: { ply: number; cp: number }[] = [];
    for (let i = 1; i <= history.length; i++) {
      const v = evalByPly[i];
      if (v !== undefined) pts.push({ ply: i, cp: v });
    }
    return pts;
  }, [evalByPly, history.length]);

  const GW = 280, GH = 76, GPX = 6, GPY = 8;
  const graphX = (ply: number) =>
    GPX + (history.length <= 1 ? 0 : ((ply - 1) / (history.length - 1)) * (GW - GPX * 2));
  const graphY = (senteCp: number) => {
    const pcp = playerColor === 0 ? senteCp : -senteCp;
    const wr = 1 / (1 + Math.exp(-pcp / 600));
    return GPY + (1 - wr) * (GH - GPY * 2);
  };
  const plyFromPointer = (e: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>) => {
    if (evalPoints.length === 0) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * GW;
    let best: number | null = null;
    let bestD = Infinity;
    for (const p of evalPoints) {
      const d = Math.abs(graphX(p.ply) - fx);
      if (d < bestD) { bestD = d; best = p.ply; }
    }
    return best;
  };
  const readoutPly = hoverPly ?? replayPly;
  const readoutText = readoutPly !== null && readoutPly > 0 && history[readoutPly - 1]
    ? `${readoutPly}手目 ${history[readoutPly - 1].notation}${
        evalByPly[readoutPly] !== undefined
          ? ` (${(playerColor === 0 ? evalByPly[readoutPly] : -evalByPly[readoutPly]) > 0 ? "+" : ""}${playerColor === 0 ? evalByPly[readoutPly] : -evalByPly[readoutPly]})`
          : ""
      }`
    : "";

  const renderHand = (owner: Player) => {
    const hand = view.hands[owner];
    const isPlayer = owner === playerColor;
    const active = !boardLocked && !gameOver && game.turn === owner;
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
              ? gameOver.winner === playerColor ? styles.statusWin
                : gameOver.winner === "draw" ? ""
                  : styles.statusLose
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

        {replayPly !== null && !preview && (
          <div className={`${styles.previewBar} ${styles.replayBar}`}>
            <span className={styles.replayTitle}>感想戦</span>
            <span className={styles.previewStep}>
              {replayPly === 0
                ? "開始局面"
                : `${replayPly}/${history.length}手 ${history[replayPly - 1]?.notation ?? ""}`}
            </span>
            <span className={styles.previewButtons}>
              <button
                className={styles.previewBtn}
                onClick={() => stepReplay(-1)}
                disabled={replayPly === 0}
                aria-label="1手戻る"
              >
                ◀
              </button>
              <button
                className={styles.previewBtn}
                onClick={() => stepReplay(1)}
                disabled={replayPly >= history.length}
                aria-label="1手進む"
              >
                ▶
              </button>
              <button className={`${styles.previewClose} ${styles.replayClose}`} onClick={closeReplay}>
                対局に戻る
              </button>
            </span>
          </div>
        )}

        {preview && (
          <div className={styles.previewBar}>
            <span className={styles.previewTitle}>
              もし{advice?.bestNotation}なら…
            </span>
            <span className={styles.previewStep}>
              {preview.idx === 0
                ? "指す前"
                : `${preview.idx}/${preview.moves.length}手 ${preview.notations[preview.idx - 1]}`}
            </span>
            <span className={styles.previewButtons}>
              <button
                className={styles.previewBtn}
                onClick={() => stepPreview(-1)}
                disabled={preview.idx === 0}
                aria-label="1手戻る"
              >
                ◀
              </button>
              <button
                className={styles.previewBtn}
                onClick={() => stepPreview(1)}
                disabled={preview.idx >= preview.snaps.length - 1}
                aria-label="1手進む"
              >
                ▶
              </button>
              <button className={styles.previewClose} onClick={closePreview}>
                対局に戻る
              </button>
            </span>
          </div>
        )}

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
                  const p = view.board[idx];
                  const isDest = !boardLocked && dests.has(idx);
                  const isSel = !boardLocked && selected?.kind === "board" && selected.sq === idx;
                  const isLast = boardLocked
                    ? overrideMove !== null && (overrideMove.to === idx || overrideMove.from === idx)
                    : lastMove?.to === idx || (lastMove?.from ?? -2) === idx;
                  const isHint = !boardLocked && hintMove !== null && (hintMove.to === idx || hintMove.from === idx);
                  const mineEff = effectCounts ? effectCounts[playerColor][idx] : 0;
                  const oppEff = effectCounts ? effectCounts[aiColor][idx] : 0;
                  const cellLabel =
                    squareName(idx) +
                    (p
                      ? ` ${ownerOf(p) === playerColor ? "あなた" : "AI"}の${KIFU_KANJI[typeOf(p)]}`
                      : " 空きマス") +
                    (isDest ? " 移動できます" : isSel ? " 選択中" : "");
                  return (
                    <button
                      type="button"
                      key={vi}
                      className={`${styles.cell} ${isLast ? styles.lastMove : ""} ${isDest ? styles.dest : ""} ${isSel ? styles.selCell : ""} ${isHint ? styles.hintCell : ""}`}
                      onClick={() => onCellClick(idx)}
                      aria-label={cellLabel}
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
                      {mineEff > 0 && (
                        <span className={`${styles.effBadge} ${styles.effMine}`} aria-hidden>
                          {mineEff}
                        </span>
                      )}
                      {oppEff > 0 && (
                        <span className={`${styles.effBadge} ${styles.effOpp}`} aria-hidden>
                          {oppEff}
                        </span>
                      )}
                    </button>
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

        {advice && !preview && (
          <div
            className={`${styles.coachCard} ${
              advice.grade === "best" || advice.grade === "good"
                ? styles.coachPraise
                : advice.grade === "dubious"
                  ? styles.coachWarn
                  : styles.coachBad
            }`}
            role="status"
          >
            <div className={styles.coachHead}>
              <span className={styles.coachChip}>{GRADE_INFO[advice.grade].label}</span>
              <span className={styles.coachTitle}>コーチ</span>
              <button
                className={styles.coachClose}
                onClick={() => setAdvice(null)}
                aria-label="コーチの助言を閉じる"
              >
                ✕
              </button>
            </div>
            <p className={styles.coachText}>
              {advice.text}
              {advice.reason && <span className={styles.coachReason}>({advice.reason})</span>}
            </p>
            {advice.pvText && (
              <p className={styles.coachPv}>読み筋: {advice.pvText}</p>
            )}
            <div className={styles.coachActions}>
              {advice.preview && (
                <button className={styles.coachBtn} onClick={openPreview}>
                  盤で再生
                </button>
              )}
              {advice.grade !== "best" && advice.grade !== "good" && advice.bestMove && (
                <button
                  className={styles.coachBtn}
                  onClick={tryBest}
                  disabled={thinking || history.length === 0}
                >
                  試してみる
                </button>
              )}
            </div>
          </div>
        )}

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
          <button
            className={`${styles.btn} ${coachOn ? styles.btnToggleOn : ""}`}
            onClick={toggleCoach}
            aria-pressed={coachOn}
          >
            コーチ {coachOn ? "ON" : "OFF"}
          </button>
          <button
            className={`${styles.btn} ${showEffects ? styles.btnToggleOn : ""}`}
            onClick={toggleEffects}
            aria-pressed={showEffects}
            title="駒の利きを盤上に表示"
          >
            利き {showEffects ? "ON" : "OFF"}
          </button>
          <button
            className={`${styles.btn} ${styles.btnDanger} ${styles.btnWide}`}
            onClick={requestResign}
            disabled={!!gameOver}
          >
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
          {evalPoints.length >= 2 && (
            <div className={styles.graphBox}>
              <div className={styles.graphHead}>
                <h3>形勢の推移</h3>
                <span className={styles.graphReadout}>{readoutText || "タップで局面を再生"}</span>
              </div>
              <svg
                className={styles.graph}
                viewBox={`0 0 ${GW} ${GH}`}
                role="img"
                aria-label="形勢の推移グラフ。タップするとその局面を盤に表示します"
                onPointerMove={e => setHoverPly(plyFromPointer(e))}
                onPointerLeave={() => setHoverPly(null)}
                onClick={e => {
                  const p = plyFromPointer(e);
                  if (p !== null) openReplay(p);
                }}
              >
                <rect x="0" y="0" width={GW} height={GH / 2} className={styles.graphZoneYou} />
                <rect x="0" y={GH / 2} width={GW} height={GH / 2} className={styles.graphZoneAi} />
                <line x1="0" y1={GH / 2} x2={GW} y2={GH / 2} className={styles.graphMid} />
                <text x="4" y="13" className={styles.graphZoneLabel}>あなた優勢</text>
                <text x="4" y={GH - 5} className={styles.graphZoneLabel}>AI優勢</text>
                {hoverPly !== null && (
                  <line
                    x1={graphX(hoverPly)} y1="2" x2={graphX(hoverPly)} y2={GH - 2}
                    className={styles.graphHover}
                  />
                )}
                {replayPly !== null && replayPly > 0 && (
                  <line
                    x1={graphX(replayPly)} y1="2" x2={graphX(replayPly)} y2={GH - 2}
                    className={styles.graphCurrent}
                  />
                )}
                <polyline
                  points={evalPoints.map(p => `${graphX(p.ply)},${graphY(p.cp)}`).join(" ")}
                  className={styles.graphLine}
                />
                {evalPoints
                  .filter(p => {
                    const g = gradeByPly[p.ply];
                    return g === "dubious" || g === "bad" || g === "blunder";
                  })
                  .map(p => (
                    <circle
                      key={p.ply}
                      cx={graphX(p.ply)} cy={graphY(p.cp)} r="3.5"
                      className={styles.graphBadDot}
                    />
                  ))}
              </svg>
            </div>
          )}
          <div className={styles.kifu} ref={kifuRef}>
            {history.length === 0 && <div className={styles.kifuEmpty}>まだ指し手はありません</div>}
            {history.map((e, i) => (
              <button
                key={i}
                type="button"
                className={`${styles.kifuLine} ${
                  replayPly === i + 1
                    ? styles.kifuSelected
                    : replayPly === null && i === history.length - 1
                      ? styles.kifuLatest
                      : ""
                }`}
                onClick={() => (replayPly === i + 1 ? closeReplay() : openReplay(i + 1))}
                aria-label={`${i + 1}手目 ${e.notation} を盤に表示`}
              >
                <span className={styles.kifuNum}>{i + 1}</span>
                <span className={styles.kifuMark}>{e.before.turn === 0 ? "☗" : "☖"}</span>
                {e.notation}
                {(gradeByPly[i + 1] === "dubious" || gradeByPly[i + 1] === "bad" || gradeByPly[i + 1] === "blunder") && (
                  <span className={styles.kifuBadMark} title={GRADE_INFO[gradeByPly[i + 1]].label}>
                    {gradeByPly[i + 1] === "dubious" ? "?!" : gradeByPly[i + 1] === "bad" ? "?" : "??"}
                  </span>
                )}
                {(gradeByPly[i + 1] === "best" || gradeByPly[i + 1] === "good") && (
                  <span className={styles.kifuGoodMark} title={GRADE_INFO[gradeByPly[i + 1]].label}>
                    {gradeByPly[i + 1] === "best" ? "!" : "○"}
                  </span>
                )}
              </button>
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
          <div
            className={styles.dialog}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={confirm.message}
          >
            <p className={styles.dialogTitle}>{confirm.message}</p>
            <div className={styles.confirmButtons}>
              <button className={styles.btn} onClick={() => setConfirm(null)} autoFocus>
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
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label="成りますか?"
          >
            <p className={styles.dialogTitle}>成りますか?</p>
            <div className={styles.promoChoices}>
              <button
                className={styles.promoChoice}
                onClick={() => applyMove(pending.find(m => m.promote)!)}
                autoFocus
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
          <div
            className={styles.dialog}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="対局結果"
          >
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
            {Object.values(gradeCounts).some(n => n > 0) && (
              <p className={styles.resultGrades}>
                {(Object.entries(GRADE_INFO) as [Grade, typeof GRADE_INFO[Grade]][])
                  .filter(([g]) => gradeCounts[g] > 0)
                  .map(([g, info]) => `${info.label}${gradeCounts[g]}`)
                  .join("・")}
                {gradeCounts.bad === 0 && gradeCounts.blunder === 0 && " — 悪手なし！"}
              </p>
            )}
            <div className={styles.resultButtons}>
              <button
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => restart(0)}
                autoFocus
              >
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
