import { Move } from "../rules/domain";
import { searchDecision, type SearchExecutor } from "./search";
import type { SearchRequest, SearchResponse } from "./worker-protocol";

/** One worker per in-flight decision: abort physically stops CPU work, not just its eventual answer. */
export const browserSearch: SearchExecutor = (engine, state, options) => {
  if (options.difficulty === "easy") return searchDecision(engine, state, options);
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" });
    const dispose = (): void => {
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = (): void => {
      dispose();
      reject(options.signal?.reason ?? new DOMException("Search cancelled", "AbortError"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = event => {
      dispose();
      reject(new Error(`Heuristic worker failed: ${event.message}`));
    };
    worker.onmessageerror = () => {
      dispose();
      reject(new Error("Heuristic worker returned an unreadable message."));
    };
    worker.onmessage = (event: MessageEvent<SearchResponse>) => {
      dispose();
      if (!event.data.ok) {
        reject(new Error(event.data.error));
        return;
      }
      const result = event.data.result;
      resolve({ ...result, move: result.move ?
        new Move(result.move.pieceId, result.move.targetPlaceIndex) : null });
    };
    try {
      const request: SearchRequest = {
        rules: JSON.stringify(engine.rules), state, difficulty: options.difficulty,
        action: options.action, moves: options.moves,
        tieSeed: options.tieSeed ?? 0,
        recentPositions: options.recentPositions,
      };
      worker.postMessage(request);
    }
    catch (error) {
      dispose();
      reject(error);
    }
  });
};
