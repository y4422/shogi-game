// USI プロトコル用の変換(SFEN 局面表記・USI 指し手表記)
import {
  Position, Move, Player,
  FU, KY, KE, GI, KI, KA, HI,
  typeOf, ownerOf, legalMoves,
} from "./shogi";

// 駒種 → SFEN 文字(先手が大文字)
const SFEN_LETTER = ["", "P", "L", "N", "S", "G", "B", "R", "K", "+P", "+L", "+N", "+S", "+B", "+R"];
const DROP_LETTER = ["", "P", "L", "N", "S", "G", "B", "R"];
// 持ち駒の SFEN 表記順
const HAND_SFEN_ORDER = [HI, KA, KI, GI, KE, KY, FU];

export function positionToSfen(pos: Position, moveCount = 1): string {
  const rows: string[] = [];
  for (let r = 0; r < 9; r++) {
    let row = "";
    let empty = 0;
    for (let c = 0; c < 9; c++) {
      const p = pos.board[r * 9 + c];
      if (p === 0) {
        empty++;
        continue;
      }
      if (empty > 0) {
        row += empty;
        empty = 0;
      }
      const letter = SFEN_LETTER[typeOf(p)];
      row += ownerOf(p) === 0 ? letter : letter.toLowerCase();
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }
  let hands = "";
  for (const o of [0, 1] as Player[]) {
    for (const t of HAND_SFEN_ORDER) {
      const n = pos.hands[o][t];
      if (n <= 0) continue;
      const letter = o === 0 ? DROP_LETTER[t] : DROP_LETTER[t].toLowerCase();
      hands += (n > 1 ? n : "") + letter;
    }
  }
  return `${rows.join("/")} ${pos.turn === 0 ? "b" : "w"} ${hands || "-"} ${moveCount}`;
}

// 盤上マス → USI 表記(例: 76 → "7g")
function sqToUsi(sq: number): string {
  const file = 9 - (sq % 9);
  const rank = String.fromCharCode(97 + ((sq / 9) | 0)); // a-i
  return `${file}${rank}`;
}

function usiToSq(s: string): number {
  const file = s.charCodeAt(0) - 48; // '1'-'9'
  const rank = s.charCodeAt(1) - 97; // 'a'-'i'
  if (file < 1 || file > 9 || rank < 0 || rank > 8) return -1;
  return rank * 9 + (9 - file);
}

export function moveToUsi(m: Move): string {
  if (m.from === -1) return `${DROP_LETTER[m.drop]}*${sqToUsi(m.to)}`;
  return `${sqToUsi(m.from)}${sqToUsi(m.to)}${m.promote ? "+" : ""}`;
}

// USI 指し手をパースし、合法手と照合して返す(非合法なら null)
export function usiToMove(pos: Position, usi: string): Move | null {
  let parsed: Move | null = null;
  const dropMatch = usi.match(/^([PLNSGBR])\*([1-9][a-i])$/);
  if (dropMatch) {
    const drop = DROP_LETTER.indexOf(dropMatch[1]);
    const to = usiToSq(dropMatch[2]);
    if (drop >= 1 && to >= 0) parsed = { from: -1, to, drop, promote: false };
  } else {
    const moveMatch = usi.match(/^([1-9][a-i])([1-9][a-i])(\+?)$/);
    if (moveMatch) {
      const from = usiToSq(moveMatch[1]);
      const to = usiToSq(moveMatch[2]);
      if (from >= 0 && to >= 0) parsed = { from, to, drop: 0, promote: moveMatch[3] === "+" };
    }
  }
  if (!parsed) return null;
  const p = parsed;
  const ok = legalMoves(pos).some(
    m => m.from === p.from && m.to === p.to && m.drop === p.drop && m.promote === p.promote
  );
  return ok ? p : null;
}
