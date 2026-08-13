// 将棋AI: 反復深化 αβ探索(PVS) + 置換表 + null move + LMR + 静止探索 + 王手延長
import {
  Position, Move, Player,
  FU, HI, OU,
  typeOf, PROMOTE, DEMOTE, makePiece,
  generateMoves, legalMoves, isAttacked, findKing,
  makeMove, unmakeMove, hasAnyLegalMove,
} from "./shogi";

// 駒の価値(歩=90 基準)
const VAL = [0, 90, 315, 405, 495, 540, 855, 990, 15000, 600, 600, 600, 600, 1080, 1300];
// 前進1段ごとの加点
const ADV = [0, 5, 3, 4, 4, 3, 2, 2, 0, 1, 1, 1, 1, 2, 2];

const INF = 1_000_000;
const MATE = 100_000;
const QMAX = 8;

const TIME_UP = Symbol("timeUp");

export interface SearchResult {
  move: Move | null;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
}

export interface SearchOptions {
  timeMs: number;
  maxDepth: number;
  noise?: number; // 評価値ノイズ(弱いレベル用)
}

// ---- Zobrist ハッシュ ----

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s | 0;
  };
}

const rng = makeRng(0x9e3779b9);
const ZP_LO = new Int32Array(32 * 81);
const ZP_HI = new Int32Array(32 * 81);
const ZH_LO = new Int32Array(2 * 8 * 19);
const ZH_HI = new Int32Array(2 * 8 * 19);
for (let i = 0; i < ZP_LO.length; i++) { ZP_LO[i] = rng(); ZP_HI[i] = rng(); }
for (let i = 0; i < ZH_LO.length; i++) { ZH_LO[i] = rng(); ZH_HI[i] = rng(); }
const ZT_LO = rng();
const ZT_HI = rng();

// ---- 置換表(モジュールで使い回し。lo/hi 両方の照合で誤用を防ぐ) ----

const TT_BITS = 19;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttLo = new Int32Array(TT_SIZE);
const ttHi = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE);
const ttFlag = new Int8Array(TT_SIZE); // 0=空 1=EXACT 2=LOWER 3=UPPER
const ttScore = new Int32Array(TT_SIZE);
const ttMove = new Int32Array(TT_SIZE);

const FLAG_EXACT = 1, FLAG_LOWER = 2, FLAG_UPPER = 3;

// 指し手のエンコード(置換表用)
function encodeMove(m: Move): number {
  if (m.from === -1) return (1 << 24) | (m.drop << 16) | m.to;
  return (m.from << 8) | (m.to << 1) | (m.promote ? 1 : 0);
}

function evaluate(pos: Position, noise: number): number {
  const { board, hands } = pos;
  let sc = 0; // 先手プラス
  let kingSq0 = -1, kingSq1 = -1;
  for (let i = 0; i < 81; i++) {
    const p = board[i];
    if (!p) continue;
    const t = p & 15;
    const o = p >> 4;
    if (t === OU) {
      if (o === 0) kingSq0 = i; else kingSq1 = i;
      continue;
    }
    const r = (i / 9) | 0;
    const adv = o === 0 ? 8 - r : r;
    const v = VAL[t] + ADV[t] * adv;
    sc += o === 0 ? v : -v;
  }
  for (let t = FU; t <= HI; t++) {
    sc += (hands[0][t] - hands[1][t]) * VAL[t];
  }
  sc += kingSafety(board, kingSq0, 0) - kingSafety(board, kingSq1, 1);
  if (noise > 0) sc += ((Math.random() * (2 * noise + 1)) | 0) - noise;
  return pos.turn === 0 ? sc : -sc;
}

function kingSafety(board: Int8Array, kingSq: number, o: number): number {
  if (kingSq < 0) return 0;
  const r = (kingSq / 9) | 0, c = kingSq % 9;
  let guard = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr > 8 || cc < 0 || cc > 8) continue;
      const p = board[rr * 9 + cc];
      if (p && (p >> 4) === o && (p & 15) !== FU) guard++;
    }
  }
  return guard * 14;
}

export class Searcher {
  pos: Position;
  deadline: number;
  nodes = 0;
  noise: number;
  killers: (Move | null)[] = [];
  history = new Map<number, number>();
  hlo = 0;
  hhi = 0;

  constructor(pos: Position, deadline: number, noise: number) {
    this.pos = pos;
    this.deadline = deadline;
    this.noise = noise;
    this.computeHash();
  }

  computeHash() {
    let lo = 0, hi = 0;
    const { board, hands, turn } = this.pos;
    for (let i = 0; i < 81; i++) {
      const p = board[i];
      if (!p) continue;
      lo ^= ZP_LO[p * 81 + i];
      hi ^= ZP_HI[p * 81 + i];
    }
    for (let o = 0; o < 2; o++) {
      for (let t = FU; t <= HI; t++) {
        const idx = (o * 8 + t) * 19 + hands[o][t];
        lo ^= ZH_LO[idx];
        hi ^= ZH_HI[idx];
      }
    }
    if (turn === 1) { lo ^= ZT_LO; hi ^= ZT_HI; }
    this.hlo = lo;
    this.hhi = hi;
  }

  private xorPiece(p: number, sq: number) {
    this.hlo ^= ZP_LO[p * 81 + sq];
    this.hhi ^= ZP_HI[p * 81 + sq];
  }

  private xorHand(o: number, t: number, n: number) {
    const idx = (o * 8 + t) * 19 + n;
    this.hlo ^= ZH_LO[idx];
    this.hhi ^= ZH_HI[idx];
  }

  // makeMove + ハッシュ差分更新(復元は呼び出し側で hlo/hhi を保存して戻す)
  doMove(m: Move): number {
    const pos = this.pos;
    const me = pos.turn;
    const cap = makeMove(pos, m);
    this.hlo ^= ZT_LO;
    this.hhi ^= ZT_HI;
    if (m.from === -1) {
      const n = pos.hands[me][m.drop]; // 減算後
      this.xorHand(me, m.drop, n + 1);
      this.xorHand(me, m.drop, n);
      this.xorPiece(makePiece(m.drop, me), m.to);
    } else {
      const placed = pos.board[m.to];
      const orig = m.promote ? makePiece(DEMOTE[typeOf(placed)], me) : placed;
      this.xorPiece(orig, m.from);
      this.xorPiece(placed, m.to);
      if (cap) {
        this.xorPiece(cap, m.to);
        const base = DEMOTE[typeOf(cap)];
        const n = pos.hands[me][base]; // 加算後
        this.xorHand(me, base, n - 1);
        this.xorHand(me, base, n);
      }
    }
    return cap;
  }

  doNull() {
    this.pos.turn = (1 - this.pos.turn) as Player;
    this.hlo ^= ZT_LO;
    this.hhi ^= ZT_HI;
  }

  undoNull() {
    this.doNull();
  }

  checkTime() {
    if ((this.nodes & 1023) === 0 && Date.now() > this.deadline) throw TIME_UP;
  }

  moveKey(m: Move): number {
    return m.from === -1 ? 81 * 81 + m.drop * 81 + m.to : m.from * 81 + m.to;
  }

  orderScore(m: Move, killer: Move | null, ttM: number): number {
    const board = this.pos.board;
    let s = 0;
    if (ttM !== 0 && encodeMove(m) === ttM) return 10_000_000;
    const cap = board[m.to];
    if (cap) s += 100_000 + VAL[typeOf(cap)] * 10 - (m.from >= 0 ? VAL[typeOf(board[m.from])] : 0);
    if (m.promote) s += 50_000 + VAL[PROMOTE[typeOf(board[m.from])]] - VAL[typeOf(board[m.from])];
    if (killer && killer.from === m.from && killer.to === m.to && killer.drop === m.drop && killer.promote === m.promote) {
      s += 40_000;
    }
    if (m.from === -1) s -= 30; // 打つ手はやや後回し
    s += this.history.get(this.moveKey(m)) ?? 0;
    return s;
  }

  orderMoves(moves: Move[], ply: number, ttM: number): Move[] {
    const killer = this.killers[ply] ?? null;
    const scored = moves.map(m => ({ m, s: this.orderScore(m, killer, ttM) }));
    scored.sort((a, b) => b.s - a.s);
    return scored.map(x => x.m);
  }

  quiesce(alpha: number, beta: number, qply: number): number {
    this.nodes++;
    this.checkTime();
    const pos = this.pos;
    const me = pos.turn;
    const opp = (1 - me) as Player;
    const check = isAttacked(pos.board, findKing(pos.board, me), opp);
    const stand = check ? -INF : evaluate(pos, this.noise);
    if (!check) {
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
      if (qply >= QMAX) return alpha;
    }

    // 王手中は取り手だけでなく、玉の移動・合駒を含む全ての応手を読む。
    const moves = generateMoves(pos, !check);
    const board = pos.board;
    moves.sort((a, b) => VAL[typeOf(board[b.to])] - VAL[typeOf(board[a.to])]);
    let legal = 0;
    for (const m of moves) {
      // 見込みのない取り合いの枝刈り(delta pruning)
      if (!check && stand + VAL[typeOf(board[m.to])] + 200 < alpha) continue;
      const saveLo = this.hlo, saveHi = this.hhi;
      const cap = this.doMove(m);
      if (isAttacked(pos.board, findKing(pos.board, me), opp)) {
        unmakeMove(pos, m, cap);
        this.hlo = saveLo; this.hhi = saveHi;
        continue;
      }
      if (m.from === -1 && m.drop === FU &&
          isAttacked(pos.board, findKing(pos.board, opp), me) &&
          !hasAnyLegalMove(pos)) {
        unmakeMove(pos, m, cap);
        this.hlo = saveLo; this.hhi = saveHi;
        continue;
      }
      legal++;
      let score: number;
      try {
        score = -this.quiesce(-beta, -alpha, qply + 1);
      } finally {
        unmakeMove(pos, m, cap);
        this.hlo = saveLo; this.hhi = saveHi;
      }
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    if (check && legal === 0) return -(MATE - qply);
    return alpha;
  }

  negamax(depth: number, alpha: number, beta: number, ply: number, allowNull: boolean): number {
    this.nodes++;
    this.checkTime();
    const pos = this.pos;
    const me = pos.turn;
    const opp = (1 - me) as Player;

    const check = isAttacked(pos.board, findKing(pos.board, me), opp);
    if (check && ply < 32) depth++; // 王手延長

    if (depth <= 0) return this.quiesce(alpha, beta, 0);

    // 置換表参照
    const idx = (this.hlo >>> (32 - TT_BITS)) & TT_MASK;
    const ttHit = ttFlag[idx] !== 0 && ttLo[idx] === this.hlo && ttHi[idx] === this.hhi;
    let ttM = 0;
    if (ttHit) {
      ttM = ttMove[idx];
      if (ttDepth[idx] >= depth) {
        let s = ttScore[idx];
        if (s > MATE - 1000) s -= ply;
        else if (s < -(MATE - 1000)) s += ply;
        const f = ttFlag[idx];
        if (f === FLAG_EXACT) return s;
        if (f === FLAG_LOWER && s >= beta) return s;
        if (f === FLAG_UPPER && s <= alpha) return s;
      }
    }

    // null move 枝刈り(王手中は不可。将棋はパスで悪化する局面が稀なので有効)
    if (allowNull && !check && depth >= 3 && beta < MATE - 1000) {
      const R = depth > 8 ? 3 : 2;
      this.doNull();
      let score: number;
      try {
        score = -this.negamax(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
      } finally {
        this.undoNull();
      }
      if (score >= beta) return beta;
    }

    const alphaOrig = alpha;
    const moves = this.orderMoves(generateMoves(pos), ply, ttM);
    let legal = 0;
    let best = -INF;
    let bestM: Move | null = null;
    for (const m of moves) {
      const saveLo = this.hlo, saveHi = this.hhi;
      const cap = this.doMove(m);
      if (isAttacked(pos.board, findKing(pos.board, me), opp)) {
        unmakeMove(pos, m, cap);
        this.hlo = saveLo; this.hhi = saveHi;
        continue;
      }
      if (m.from === -1 && m.drop === FU &&
          isAttacked(pos.board, findKing(pos.board, opp), me) &&
          !hasAnyLegalMove(pos)) {
        unmakeMove(pos, m, cap);
        this.hlo = saveLo; this.hhi = saveHi;
        continue;
      }
      let score: number;
      try {
        if (legal === 0) {
          score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
        } else {
          // LMR: 後方の静かな手は縮小して null window 検索
          let r = 0;
          if (depth >= 3 && legal >= 5 && !cap && !m.promote && !check) {
            r = 1 + (legal >= 18 ? 1 : 0);
          }
          score = -this.negamax(depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
          if (score > alpha && r > 0) {
            score = -this.negamax(depth - 1, -alpha - 1, -alpha, ply + 1, true);
          }
          if (score > alpha && score < beta) {
            score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, true);
          }
        }
      } finally {
        unmakeMove(pos, m, cap);
        this.hlo = saveLo; this.hhi = saveHi;
      }
      legal++;
      if (score > best) {
        best = score;
        bestM = m;
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!pos.board[m.to]) {
          this.killers[ply] = m;
          const k = this.moveKey(m);
          this.history.set(k, (this.history.get(k) ?? 0) + depth * depth);
        }
        break;
      }
    }
    if (legal === 0) return -(MATE - ply); // 詰み(またはステイルメイト=負け)

    // 置換表へ保存
    let stored = best;
    if (stored > MATE - 1000) stored += ply;
    else if (stored < -(MATE - 1000)) stored -= ply;
    ttLo[idx] = this.hlo;
    ttHi[idx] = this.hhi;
    ttDepth[idx] = depth;
    ttScore[idx] = stored;
    ttFlag[idx] = best <= alphaOrig ? FLAG_UPPER : best >= beta ? FLAG_LOWER : FLAG_EXACT;
    ttMove[idx] = bestM ? encodeMove(bestM) : 0;
    return best;
  }
}

export function searchBestMove(pos: Position, opts: SearchOptions): SearchResult {
  const start = Date.now();
  const rootMoves = legalMoves(pos);
  if (rootMoves.length === 0) {
    return { move: null, score: -MATE, depth: 0, nodes: 0, timeMs: 0 };
  }
  if (rootMoves.length === 1) {
    return { move: rootMoves[0], score: 0, depth: 0, nodes: 0, timeMs: Date.now() - start };
  }

  const searcher = new Searcher(pos, start + opts.timeMs, opts.noise ?? 0);
  let bestMove = rootMoves[0];
  let bestScore = 0;
  let completedDepth = 0;

  let ordered = searcher.orderMoves(rootMoves, 0, 0);

  try {
    for (let depth = 1; depth <= opts.maxDepth; depth++) {
      // 前回の最善手を先頭に(タイムアウト時も部分結果が使えるように)
      ordered = [bestMove, ...ordered.filter(m => m !== bestMove)];
      let alpha = -INF;
      let first = true;
      for (const m of ordered) {
        const saveLo = searcher.hlo, saveHi = searcher.hhi;
        const cap = searcher.doMove(m);
        let score: number;
        try {
          if (first) {
            score = -searcher.negamax(depth - 1, -INF, -alpha, 1, true);
          } else {
            score = -searcher.negamax(depth - 1, -alpha - 1, -alpha, 1, true);
            if (score > alpha) {
              score = -searcher.negamax(depth - 1, -INF, -alpha, 1, true);
            }
          }
        } finally {
          unmakeMove(pos, m, cap);
          searcher.hlo = saveLo; searcher.hhi = saveHi;
        }
        if (first || score > alpha) {
          alpha = score;
          bestMove = m;
          bestScore = score;
        }
        first = false;
      }
      completedDepth = depth;
      if (bestScore > MATE - 1000 || bestScore < -(MATE - 1000)) break;
    }
  } catch (e) {
    if (e !== TIME_UP) throw e;
  }

  return {
    move: bestMove,
    score: bestScore,
    depth: completedDepth,
    nodes: searcher.nodes,
    timeMs: Date.now() - start,
  };
}
