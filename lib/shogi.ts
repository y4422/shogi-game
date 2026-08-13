// 将棋のルールエンジン
// 盤面: 81 マス。index = row * 9 + col。row 0 が上段(後手陣)、col 0 が左端(9筋)。
// 先手(0)は下から上へ、後手(1)は上から下へ進む。

export const EMPTY = 0;
export const FU = 1, KY = 2, KE = 3, GI = 4, KI = 5, KA = 6, HI = 7, OU = 8;
export const TO = 9, NY = 10, NK = 11, NG = 12, UM = 13, RY = 14;

export type Player = 0 | 1; // 0 = 先手, 1 = 後手

export const typeOf = (p: number) => p & 15;
export const ownerOf = (p: number) => (p >> 4) as Player;
export const makePiece = (t: number, o: number) => t | (o << 4);

// 成り: FU→TO, KY→NY, KE→NK, GI→NG, KA→UM, HI→RY
export const PROMOTE = [0, TO, NY, NK, NG, 0, UM, RY, 0, 0, 0, 0, 0, 0, 0];
// 成り駒 → 元の駒(持ち駒になる時)
export const DEMOTE = [0, FU, KY, KE, GI, KI, KA, HI, OU, FU, KY, KE, GI, KA, HI];

export interface Position {
  board: Int8Array; // 長さ81、駒コード(0=空)
  hands: [Int8Array, Int8Array]; // [先手, 後手] index=基本駒種(FU..HI)
  turn: Player;
}

export interface Move {
  from: number; // 0..80、打つ手は -1
  to: number;
  drop: number; // 打つ手のとき駒種、それ以外 0
  promote: boolean;
}

// 8方向(順序は対称: 逆方向は index 7-i)
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1],
];

const dirIndex = (dr: number, dc: number) => DIRS.findIndex(d => d[0] === dr && d[1] === dc);

function stepsFor(t: number, o: number): number[][] {
  const f = o === 0 ? -1 : 1;
  switch (t) {
    case FU: return [[f, 0]];
    case KE: return [[2 * f, -1], [2 * f, 1]];
    case GI: return [[f, -1], [f, 0], [f, 1], [-f, -1], [-f, 1]];
    case KI: case TO: case NY: case NK: case NG:
      return [[f, -1], [f, 0], [f, 1], [0, -1], [0, 1], [-f, 0]];
    case OU: return DIRS.map(d => [d[0], d[1]]);
    case UM: return [[-1, 0], [1, 0], [0, -1], [0, 1]];
    case RY: return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    default: return [];
  }
}

function slidesFor(t: number, o: number): number[][] {
  const f = o === 0 ? -1 : 1;
  switch (t) {
    case KY: return [[f, 0]];
    case KA: case UM: return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    case HI: case RY: return [[-1, 0], [1, 0], [0, -1], [0, 1]];
    default: return [];
  }
}

export const STEPS: number[][][][] = [[], []];
export const SLIDES: number[][][][] = [[], []];
// 8方向ビットマスク(桂馬は別処理)
const stepMask: number[][] = [new Array(15).fill(0), new Array(15).fill(0)];
const slideMask: number[][] = [new Array(15).fill(0), new Array(15).fill(0)];

for (let o = 0; o < 2; o++) {
  for (let t = 0; t < 15; t++) {
    STEPS[o][t] = stepsFor(t, o);
    SLIDES[o][t] = slidesFor(t, o);
    for (const [dr, dc] of STEPS[o][t]) {
      const i = dirIndex(dr, dc);
      if (i >= 0) stepMask[o][t] |= 1 << i;
    }
    for (const [dr, dc] of SLIDES[o][t]) {
      const i = dirIndex(dr, dc);
      if (i >= 0) slideMask[o][t] |= 1 << i;
    }
  }
}

export function initialPosition(): Position {
  const board = new Int8Array(81);
  const back = [KY, KE, GI, KI, OU, KI, GI, KE, KY];
  for (let c = 0; c < 9; c++) {
    board[0 * 9 + c] = makePiece(back[c], 1);
    board[8 * 9 + c] = makePiece(back[c], 0);
    board[2 * 9 + c] = makePiece(FU, 1);
    board[6 * 9 + c] = makePiece(FU, 0);
  }
  board[1 * 9 + 1] = makePiece(HI, 1); // 後手飛 8二
  board[1 * 9 + 7] = makePiece(KA, 1); // 後手角 2二
  board[7 * 9 + 1] = makePiece(KA, 0); // 先手角 8八
  board[7 * 9 + 7] = makePiece(HI, 0); // 先手飛 2八
  return { board, hands: [new Int8Array(8), new Int8Array(8)], turn: 0 };
}

export function clonePosition(pos: Position): Position {
  return {
    board: Int8Array.from(pos.board),
    hands: [Int8Array.from(pos.hands[0]), Int8Array.from(pos.hands[1])],
    turn: pos.turn,
  };
}

// 指す。戻り値は取った駒コード(undo 用)
export function makeMove(pos: Position, m: Move): number {
  const me = pos.turn;
  if (m.from === -1) {
    pos.board[m.to] = makePiece(m.drop, me);
    pos.hands[me][m.drop]--;
    pos.turn = (1 - me) as Player;
    return 0;
  }
  const p = pos.board[m.from];
  const cap = pos.board[m.to];
  pos.board[m.from] = EMPTY;
  pos.board[m.to] = m.promote ? makePiece(PROMOTE[typeOf(p)], me) : p;
  if (cap) pos.hands[me][DEMOTE[typeOf(cap)]]++;
  pos.turn = (1 - me) as Player;
  return cap;
}

export function unmakeMove(pos: Position, m: Move, cap: number): void {
  const me = (1 - pos.turn) as Player;
  pos.turn = me;
  if (m.from === -1) {
    pos.board[m.to] = EMPTY;
    pos.hands[me][m.drop]++;
    return;
  }
  const p = pos.board[m.to];
  pos.board[m.from] = m.promote ? makePiece(DEMOTE[typeOf(p)], me) : p;
  pos.board[m.to] = cap;
  if (cap) pos.hands[me][DEMOTE[typeOf(cap)]]--;
}

export function findKing(board: Int8Array, o: Player): number {
  const k = makePiece(OU, o);
  for (let i = 0; i < 81; i++) if (board[i] === k) return i;
  return -1;
}

// sq が by 側の駒に利いているか
export function isAttacked(board: Int8Array, sq: number, by: Player): boolean {
  if (sq < 0) return false;
  const r = (sq / 9) | 0, c = sq % 9;
  // 桂馬
  const f = by === 0 ? -1 : 1;
  const kr = r - 2 * f;
  if (kr >= 0 && kr < 9) {
    const keCode = makePiece(KE, by);
    if (c - 1 >= 0 && board[kr * 9 + c - 1] === keCode) return true;
    if (c + 1 < 9 && board[kr * 9 + c + 1] === keCode) return true;
  }
  // 8方向のレイ
  for (let i = 0; i < 8; i++) {
    const dr = DIRS[i][0], dc = DIRS[i][1];
    let rr = r + dr, cc = c + dc, d = 1;
    while (rr >= 0 && rr < 9 && cc >= 0 && cc < 9) {
      const p = board[rr * 9 + cc];
      if (p !== EMPTY) {
        if ((p >> 4) === by) {
          const t = p & 15;
          const ob = 1 << (7 - i); // 駒→sq 方向
          if (slideMask[by][t] & ob) return true;
          if (d === 1 && stepMask[by][t] & ob) return true;
        }
        break;
      }
      rr += dr; cc += dc; d++;
    }
  }
  return false;
}

export function inCheck(pos: Position): boolean {
  return isAttacked(pos.board, findKing(pos.board, pos.turn), (1 - pos.turn) as Player);
}

const inZone = (o: Player, r: number) => (o === 0 ? r <= 2 : r >= 6);

function pushBoardMove(moves: Move[], turn: Player, t: number, from: number, to: number) {
  const fr = (from / 9) | 0, tr = (to / 9) | 0;
  const canP = PROMOTE[t] !== 0 && (inZone(turn, fr) || inZone(turn, tr));
  const must =
    (t === FU || t === KY) ? (turn === 0 ? tr === 0 : tr === 8) :
    t === KE ? (turn === 0 ? tr <= 1 : tr >= 7) : false;
  if (canP) {
    moves.push({ from, to, drop: 0, promote: true });
    if (!must) moves.push({ from, to, drop: 0, promote: false });
  } else {
    moves.push({ from, to, drop: 0, promote: false });
  }
}

// 疑似合法手(自玉の安全・打ち歩詰めは未チェック)
export function generateMoves(pos: Position, capturesOnly = false): Move[] {
  const { board, turn } = pos;
  const moves: Move[] = [];
  for (let from = 0; from < 81; from++) {
    const p = board[from];
    if (!p || (p >> 4) !== turn) continue;
    const t = p & 15;
    const r = (from / 9) | 0, c = from % 9;
    for (const [dr, dc] of STEPS[turn][t]) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr > 8 || cc < 0 || cc > 8) continue;
      const to = rr * 9 + cc;
      const q = board[to];
      if (q && (q >> 4) === turn) continue;
      if (capturesOnly && !q) continue;
      pushBoardMove(moves, turn, t, from, to);
    }
    for (const [dr, dc] of SLIDES[turn][t]) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 9 && cc >= 0 && cc < 9) {
        const to = rr * 9 + cc;
        const q = board[to];
        if (q && (q >> 4) === turn) break;
        if (!capturesOnly || q) pushBoardMove(moves, turn, t, from, to);
        if (q) break;
        rr += dr; cc += dc;
      }
    }
  }
  if (capturesOnly) return moves;
  // 持ち駒を打つ
  const hand = pos.hands[turn];
  let hasHand = false;
  for (let t = FU; t <= HI; t++) if (hand[t] > 0) { hasHand = true; break; }
  if (hasHand) {
    const lastRank = turn === 0 ? 0 : 8;
    const pawnFile = new Array<boolean>(9).fill(false);
    if (hand[FU] > 0) {
      const fuCode = makePiece(FU, turn);
      for (let i = 0; i < 81; i++) if (board[i] === fuCode) pawnFile[i % 9] = true;
    }
    for (let to = 0; to < 81; to++) {
      if (board[to]) continue;
      const r = (to / 9) | 0;
      for (let t = FU; t <= HI; t++) {
        if (!hand[t]) continue;
        if (t === FU && (pawnFile[to % 9] || r === lastRank)) continue; // 二歩・行き所なし
        if (t === KY && r === lastRank) continue;
        if (t === KE && (turn === 0 ? r <= 1 : r >= 7)) continue;
        moves.push({ from: -1, to, drop: t, promote: false });
      }
    }
  }
  return moves;
}

// 疑似合法手のうち、自玉が取られない手が1つでもあるか
export function hasAnyLegalMove(pos: Position): boolean {
  const me = pos.turn;
  const moves = generateMoves(pos);
  for (const m of moves) {
    const cap = makeMove(pos, m);
    const safe = !isAttacked(pos.board, findKing(pos.board, me), (1 - me) as Player);
    unmakeMove(pos, m, cap);
    if (safe) return true;
  }
  return false;
}

// 完全な合法手(自玉の安全 + 打ち歩詰め)
export function legalMoves(pos: Position): Move[] {
  const me = pos.turn;
  const opp = (1 - me) as Player;
  const result: Move[] = [];
  for (const m of generateMoves(pos)) {
    const cap = makeMove(pos, m);
    let ok = !isAttacked(pos.board, findKing(pos.board, me), opp);
    if (ok && m.from === -1 && m.drop === FU) {
      // 打ち歩詰め: 歩を打って王手 かつ 相手に合法手なし → 反則
      const oppKing = findKing(pos.board, opp);
      if (isAttacked(pos.board, oppKing, me) && !hasAnyLegalMove(pos)) ok = false;
    }
    unmakeMove(pos, m, cap);
    if (ok) result.push(m);
  }
  return result;
}

// ---- 表記(棋譜) ----

export const PIECE_KANJI = ["", "歩", "香", "桂", "銀", "金", "角", "飛", "玉", "と", "杏", "圭", "全", "馬", "竜"];
export const KIFU_KANJI = ["", "歩", "香", "桂", "銀", "金", "角", "飛", "玉", "と", "成香", "成桂", "成銀", "馬", "竜"];
const RANK_KANJI = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const FILE_NUM = ["９", "８", "７", "６", "５", "４", "３", "２", "１"];

export function squareName(sq: number): string {
  return FILE_NUM[sq % 9] + RANK_KANJI[(sq / 9) | 0];
}

export function moveToKifu(pos: Position, m: Move, prevTo: number): string {
  const mark = pos.turn === 0 ? "▲" : "△";
  const dest = m.to === prevTo ? "同" : squareName(m.to);
  if (m.from === -1) {
    return `${mark}${dest}${KIFU_KANJI[m.drop]}打`;
  }
  const t = typeOf(pos.board[m.from]);
  const canP = PROMOTE[t] !== 0 &&
    (inZone(pos.turn, (m.from / 9) | 0) || inZone(pos.turn, (m.to / 9) | 0));
  const suffix = m.promote ? "成" : canP ? "不成" : "";
  return `${mark}${dest}${KIFU_KANJI[t]}${suffix}`;
}

export const sameMove = (a: Move, b: Move) =>
  a.from === b.from && a.to === b.to && a.drop === b.drop && a.promote === b.promote;
