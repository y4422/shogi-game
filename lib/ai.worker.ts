// AI 探索を UI スレッドから切り離す Web Worker
import { Position, Player } from "./shogi";
import { searchBestMove, SearchOptions } from "./ai";

interface WorkerRequest {
  board: number[];
  hands: [number[], number[]];
  turn: Player;
  opts: SearchOptions;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { board, hands, turn, opts } = e.data;
  const pos: Position = {
    board: Int8Array.from(board),
    hands: [Int8Array.from(hands[0]), Int8Array.from(hands[1])],
    turn,
  };
  const result = searchBestMove(pos, opts);
  self.postMessage(result);
};
