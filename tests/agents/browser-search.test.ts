import { afterEach, describe, expect, it, vi } from "vitest";
import { browserSearch } from "../../src/agents/browser-search";
import { executeSearchRequest, type SearchRequest, type SearchResponse } from "../../src/agents/worker-protocol";
import { EngineOptions, PieceOwner } from "../../src/rules/domain";
import { testEngine } from "../helpers/board";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<SearchResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  request: SearchRequest | null = null;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(request: SearchRequest): void { this.request = request; }
  terminate(): void { this.terminated = true; }
}
afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe("browser search lifecycle", () => {
  it("physically terminates a busy worker when a decision is cancelled", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const engine = testEngine();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));
    const abort = new AbortController();
    const pending = browserSearch(engine, state, {
      action: "move", difficulty: "hard", signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toHaveProperty("name", "AbortError");
    const worker = FakeWorker.instances[0];
    expect(worker.request?.difficulty).toBe("hard");
    abort.abort();
    await rejected;
    expect(worker.terminated).toBe(true);
  });

  it("returns rehydrated moves and terminates the completed worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const engine = testEngine();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));
    const pending = browserSearch(engine, state, { action: "move", difficulty: "medium", tieSeed: 5 });
    const worker = FakeWorker.instances[0];
    const result = await executeSearchRequest(worker.request!);
    worker.onmessage?.({ data: { ok: true, result: structuredClone(result) } } as MessageEvent<SearchResponse>);
    expect(await pending).toEqual(result);
    expect(worker.terminated).toBe(true);
  });

  it("surfaces worker failures rather than silently making a different decision", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const engine = testEngine();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));
    const pending = browserSearch(engine, state, { action: "move", difficulty: "hard" });
    const rejected = expect(pending).rejects.toThrow("broken");
    FakeWorker.instances[0].onmessage?.({
      data: { ok: false, error: "broken" },
    } as MessageEvent<SearchResponse>);
    await rejected;
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it("terminates workers when posting a request fails", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const post = vi.spyOn(FakeWorker.prototype, "postMessage")
      .mockImplementationOnce(() => { throw new Error("cannot clone"); });
    const engine = testEngine();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));
    await expect(browserSearch(engine, state, { action: "move", difficulty: "hard" }))
      .rejects.toThrow("cannot clone");
    expect(FakeWorker.instances[0].terminated).toBe(true);
    post.mockRestore();
  });

  it("rejects unreadable worker responses and releases the worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const engine = testEngine();
    const state = engine.initGame(new EngineOptions(PieceOwner.P1, true));
    const pending = browserSearch(engine, state, { action: "move", difficulty: "hard" });
    const rejected = expect(pending).rejects.toThrow("unreadable message");
    FakeWorker.instances[0].onmessageerror?.();
    await rejected;
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });
});
