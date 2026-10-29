/**
 * Vitest port of the retired C# `LlmAgentTests` suite and the reading half of `LlmConfigTests`.
 *
 * Everything here runs offline: the endpoint is a scripted `LlmTransport`, so the fallback matrix (HTTP
 * error, timeout, malformed answer, out-of-range index, cancellation) is pinned without a model or a
 * server, and the shared `llm-config.json` is exercised against a fresh temporary directory.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DieFace,
  Move,
  PieceOwner,
  PieceType,
  RerollDecision,
  TurnPhase,
} from "../../src/rules/domain";
import type { RulesEngine } from "../../src/rules/engine";
import {
  LlmConfigFile,
  DefaultEndpoint,
  DefaultModel,
  normalizeEndpoint,
  normalizeModel,
} from "../../src/agents/config";
import {
  FetchLlmTransport,
  LlmConfig,
  LlmPlayerAgent,
  LlmResponseParser,
  SahkkuGameRules,
  type LlmFetch,
  type LlmHttpResponse,
  type LlmTransport,
} from "../../src/agents/llm";
import { HeuristicPlayerAgent } from "../../src/agents/heuristic";
import { Board, testEngine } from "../helpers/board";

/**
 * Stands in for the HTTP transport: records every request and answers with a scripted body, or fails with
 * a scripted exception. Nothing here touches a socket.
 */
class MockLlmTransport implements LlmTransport {
  readonly endpoints: string[] = [];
  readonly requests: string[] = [];

  /** Thrown instead of answering, e.g. an HTTP 500 the fetch transport surfaced. */
  failure: Error | null = null;

  private readonly respond: (requestJson: string) => string;

  constructor(responseBody: string | ((requestJson: string) => string)) {
    this.respond = typeof responseBody === "function" ? responseBody : () => responseBody;
  }

  get calls(): number {
    return this.requests.length;
  }

  postChatCompletion(endpointUrl: string, requestJson: string): Promise<string> {
    this.endpoints.push(endpointUrl);
    this.requests.push(requestJson);
    if (this.failure != null) return Promise.reject(this.failure);
    return Promise.resolve(this.respond(requestJson));
  }
}

/** An OpenAI-compatible chat-completion body whose single message is `content`. */
function chat(content: string): string {
  return `{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":${JSON.stringify(content)}},"finish_reason":"stop"}]}`;
}

function agent(engine: RulesEngine, transport: LlmTransport | null, log?: (message: string) => void): LlmPlayerAgent {
  return new LlmPlayerAgent(PieceOwner.P1, "NPC", transport, new LlmConfig(), engine, log ?? null);
}

function boardWithChoices(engine: RulesEngine): Board {
  const board = new Board(engine);
  board.addOnArc(10, PieceType.Soldier, PieceOwner.P1, true);
  board.addOnArc(40, PieceType.Soldier, PieceOwner.P1, true);
  board.setDice(DieFace.Sahhku, DieFace.Zero, DieFace.Zero);
  board.phase(TurnPhase.P1move);
  return board;
}

/** A board whose throw offers no re-roll at all (no sáhkku is up). */
function boardWithoutReroll(engine: RulesEngine): Board {
  const board = new Board(engine);
  board.addOnArc(10, PieceType.Soldier, PieceOwner.P1, true);
  board.setDice(DieFace.Zero, DieFace.Zero, DieFace.Zero);
  board.phase(TurnPhase.P1move);
  return board;
}

function expectSameMove(expected: Move, actual: Move | null): void {
  expect(actual == null ? null : { pieceId: actual.pieceId, target: actual.targetPlaceIndex }).toEqual({
    pieceId: expected.pieceId,
    target: expected.targetPlaceIndex,
  });
}

// ------------------------------------------------------------------ reading the model's answer

describe("LlmAgentTests", () => {
  it("DecideMove_UsesTheIndexTheEndpointReturned", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);
    expect(legalMoves.length, "the fixture has to offer a choice").toBeGreaterThan(1);

    const transport = new MockLlmTransport(chat('{"move_index": 1, "reasoning": "capturing"}'));
    const chosen = await agent(engine, transport).decideMove(board.state, legalMoves);

    expectSameMove(legalMoves[1], chosen);
    expect(engine.isLegalMove(board.state, chosen as Move), "an index into the legal list is legal by construction").toBe(true);
    expect(transport.calls).toBe(1);
  });

  it("DecideMove_SendsTheBoardContextAndTheJSONContract", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport(chat('{"move_index": 0}'));
    await agent(engine, transport).decideMove(board.state, legalMoves);

    const request = transport.requests[0];
    expect(transport.endpoints[0]).toBe("http://localhost:1234/v1/chat/completions");
    expect(request, "when model is blank, the model field is omitted").not.toContain('"model"');
    expect(request).toContain('"stream":false');
    expect(request, "the engine's own move list is what the model ranks").toContain("## Legal moves");
    expect(request).toContain("move_index");
    expect(request, "the numbered list describes the piece the engine found").toContain(`#${legalMoves[0].pieceId}`);

    // When a model name is explicitly configured, it is included in the request payload
    const customConfig = new LlmConfig({ modelName: "custom-model" });
    const customAgent = new LlmPlayerAgent(PieceOwner.P1, "NPC", transport, customConfig, engine);
    await customAgent.decideMove(board.state, legalMoves);
    expect(transport.requests[1]).toContain('"model":"custom-model"');
  });

  it("DecideMove_InitialTurn_SendsRulesAndBoardContext", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport(chat('{"move_index": 0, "reasoning": "opening"}'));
    const subject = agent(engine, transport);
    await subject.decideMove(board.state, legalMoves);

    expect(transport.calls).toBe(1);
    const request = JSON.parse(transport.requests[0]);
    expect(request.messages).toHaveLength(2);
    expect(request.messages[0].role).toBe("system");
    expect(request.messages[1].role).toBe("user");

    // The initial prompt must contain the full rules as well as the board state
    expect(request.messages[1].content).toContain(SahkkuGameRules);
    expect(request.messages[1].content).toContain("# Sahkku decision context");
    expect(request.messages[1].content).toContain("## Board");
    expect(request.messages[1].content).toContain("## Legal moves");
  });

  it("DecideMove_SubsequentTurn_KeepsSessionAndSendsOnlyBoardContextLater", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport(chat('{"move_index": 0, "reasoning": "step"}'));
    const subject = agent(engine, transport);

    // Turn 1
    await subject.decideMove(board.state, legalMoves);
    expect(transport.calls).toBe(1);

    // Turn 2: into the same agent session
    await subject.decideMove(board.state, legalMoves);
    expect(transport.calls).toBe(2);

    const secondRequest = JSON.parse(transport.requests[1]);
    // The session should now have 4 messages: system, user(turn1), assistant(turn1), user(turn2)
    expect(secondRequest.messages).toHaveLength(4);
    expect(secondRequest.messages[0].role).toBe("system");
    expect(secondRequest.messages[1].role).toBe("user");
    expect(secondRequest.messages[1].content).toContain(SahkkuGameRules);

    expect(secondRequest.messages[2].role).toBe("assistant");
    expect(secondRequest.messages[2].content).toContain('"move_index": 0');

    expect(secondRequest.messages[3].role).toBe("user");
    // Turn 2 contains the new board state, but does NOT re-send the rules
    expect(secondRequest.messages[3].content).toContain("# Sahkku decision context");
    expect(secondRequest.messages[3].content).not.toContain(SahkkuGameRules);
  });

  it("DecideMove_ResetSession_ClearsHistoryAndReincludesRules", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport(chat('{"move_index": 0}'));
    const subject = agent(engine, transport);

    await subject.decideMove(board.state, legalMoves);
    expect(subject.getSessionMessages()).toHaveLength(3); // system, user, assistant

    subject.resetSession();
    expect(subject.getSessionMessages()).toHaveLength(0);

    // Next decision starts fresh with rules in the initial user turn
    await subject.decideMove(board.state, legalMoves);
    const request = JSON.parse(transport.requests[1]);
    expect(request.messages).toHaveLength(2);
    expect(request.messages[1].content).toContain(SahkkuGameRules);
  });

  it("DecideReroll_MaintainsSessionAcrossRerollAndMove", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport((req) => {
      if (req.includes("reroll")) return chat('{"reroll": false, "reasoning": "keep"}');
      return chat('{"move_index": 0, "reasoning": "advance"}');
    });
    const subject = agent(engine, transport);

    // Initial action: reroll decision
    const reroll = await subject.decideReroll(board.state);
    expect(reroll).toBe(RerollDecision.KeepDiceAndProceed);

    const rerollReq = JSON.parse(transport.requests[0]);
    expect(rerollReq.messages).toHaveLength(2);
    expect(rerollReq.messages[1].content).toContain(SahkkuGameRules);
    expect(rerollReq.messages[1].content).toContain("Should the sáhkku die be thrown again?");

    // Subsequent action in same turn: move decision
    const move = await subject.decideMove(board.state, legalMoves);
    expectSameMove(legalMoves[0], move);

    const moveReq = JSON.parse(transport.requests[1]);
    // Maintains session: system, user(reroll), assistant(reroll), user(move)
    expect(moveReq.messages).toHaveLength(4);
    expect(moveReq.messages[2].content).toContain('"reroll": false');
    expect(moveReq.messages[3].content).toContain("## Legal moves");
    expect(moveReq.messages[3].content).not.toContain(SahkkuGameRules);
  });

  it("Session_CapsHistoryLengthWhileMaintainingSystemPrompt", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport(() => chat('{"move_index": 0}'));
    const subject = agent(engine, transport);

    // Run 20 decision turns (which without a cap would generate 1 + 20*2 = 41 messages)
    for (let i = 0; i < 20; i++) {
      await subject.decideMove(board.state, legalMoves);
    }

    const messages = subject.getSessionMessages();
    expect(messages.length).toBeLessThanOrEqual(30);
    expect(messages[0].role).toBe("system");
  });

  it("DecideMove_ReadsMarkdownFencedJSON", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport(chat('```json\n{"move_index": 1, "reasoning": "attack"}\n```'));
    const chosen = await agent(engine, transport).decideMove(board.state, legalMoves);

    expectSameMove(legalMoves[1], chosen);
  });

  it("DecideMove_ReadsJSONOutOfConversationalProse", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport(
      chat('Sure! Let me think about it.\nThe best option is {"move_index": 1, "reasoning": "advance"} because it attacks.'),
    );
    const chosen = await agent(engine, transport).decideMove(board.state, legalMoves);

    expectSameMove(legalMoves[1], chosen);
  });

  it("DecideMove_ReadsAPlainDecisionBodyWithoutTheEnvelope", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport('{"move_index": 0, "reasoning": "activate"}');
    const chosen = await agent(engine, transport).decideMove(board.state, legalMoves);

    expectSameMove(legalMoves[0], chosen);
  });

  it("Parser_AcceptsTheTolerantFormsSmallModelsEmit", () => {
    expect(LlmResponseParser.tryParseMoveIndex(chat('{"moveIndex": "2"}'), 3)).toBe(2);
    expect(LlmResponseParser.tryParseMoveIndex(chat('{"move_index": 3}'), 3), "the list has three moves: 0..2").toBeNull();
    expect(LlmResponseParser.tryParseMoveIndex(chat('{"move_index": -1}'), 3)).toBeNull();
    expect(LlmResponseParser.tryParseMoveIndex(chat('{"move_index": 1.5}'), 3)).toBeNull();
    expect(LlmResponseParser.tryParseMoveIndex(chat("no JSON at all"), 3)).toBeNull();
    expect(LlmResponseParser.tryParseMoveIndex(null, 3)).toBeNull();

    expect(LlmResponseParser.tryParseReroll(chat('{"reroll": "true"}'))).toBe(true);
    expect(LlmResponseParser.tryParseReroll(chat('{"reroll": false}'))).toBe(false);
    expect(LlmResponseParser.tryParseReroll(chat('{"reroll": "maybe"}'))).toBeNull();
    expect(LlmResponseParser.tryParseReroll(chat('{"move_index": 1}'))).toBeNull();
  });

  it("Parser_ReadsDecisionFromReasoningContentWhenContentIsEmpty", () => {
    const envelope = JSON.stringify({
      id: "test",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            reasoning_content: 'I will pick move 1. {"move_index": 1, "reasoning": "advance"}',
          },
        },
      ],
    });
    expect(LlmResponseParser.tryParseMoveIndex(envelope, 3)).toBe(1);
    expect(LlmResponseParser.readReasoning(envelope)).toBe("advance");
  });

  it("Parser_StaysTotalWhenTheAnswerIsNotReadableJSON", () => {
    // The platform reader refuses a malformed \u escape (a model writing a Windows path inside its
    // reasoning, say) exactly like malformed JSON. The parser promises "null, never an exception", so
    // both have to mean the same thing: the answer cannot be used. Without this the agent still recovers
    // (it catches everything), but it reports a network-style failure for what is really an unusable
    // answer, and every other caller of the parser gets an exception it was told could not happen.
    expect(LlmResponseParser.tryParseMoveIndex(chat('{"move_index": 1, "reasoning": "C:\\users\\bob"}'), 3)).toBeNull();
    expect(LlmResponseParser.tryParseMoveIndex('{"reasoning": "\\uZZZZ"}', 3)).toBeNull();
    expect(LlmResponseParser.tryParseReroll(chat('{"reroll": true, "reasoning": "\\uZZZZ"}'))).toBeNull();
    expect(LlmResponseParser.readReasoning(chat('{"reasoning": "\\uZZZZ"}'))).toBeNull();
    // An unreadable body is not an envelope, so it stays its own decision text (as documented) — what
    // matters is that reading it back does not throw either.
    expect(LlmResponseParser.decisionText('{"reasoning": "\\uZZZZ"}')).toBe('{"reasoning": "\\uZZZZ"}');

    // An unreadable candidate is skipped, not fatal: a readable one behind it still answers.
    expect(LlmResponseParser.tryParseMoveIndex('{"reasoning": "\\uZZZZ"} and the answer is {"move_index": 2}', 3)).toBe(2);
  });

  // ------------------------------------------------------------------ the fallback matrix

  it("DecideMove_FallsBackToTheHeuristicWhenTheRequestFails", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);
    const heuristic = await new HeuristicPlayerAgent(PieceOwner.P1, null, engine).decideMove(board.state, legalMoves);

    const transport = new MockLlmTransport(chat("{}"));
    transport.failure = new Error("Response status code does not indicate success: 500 (Internal Server Error).");
    const chosen = await agent(engine, transport).decideMove(board.state, legalMoves);

    expectSameMove(heuristic as Move, chosen);
    expect(transport.calls).toBe(1);
  });

  it("DecideMove_FallsBackToTheHeuristicWhenTheRequestTimesOut", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);
    const heuristic = await new HeuristicPlayerAgent(PieceOwner.P1, null, engine).decideMove(board.state, legalMoves);

    // A transport deadline surfaces as a rejection whose reason is *not* the caller's abort, which is
    // exactly how the agent tells a slow model from a cancelled match.
    const transport = new MockLlmTransport(chat("{}"));
    transport.failure = Object.assign(new Error("The request timed out."), { name: "TimeoutError" });
    const chosen = await agent(engine, transport).decideMove(board.state, legalMoves);

    expectSameMove(heuristic as Move, chosen);
  });

  it("DecideMove_FallsBackToTheHeuristicOnAnUnusableAnswer", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);
    const heuristic = await new HeuristicPlayerAgent(PieceOwner.P1, null, engine).decideMove(board.state, legalMoves);

    const unusable = [
      chat("I am not sure what to play."), // no JSON at all
      chat('{"move_index": 99}'), // out of range
      chat('{"moveindex": 1}'), // misspelled key
      chat('{"move_index": }'), // truncated JSON
      chat('{"move_index": 1'), // unterminated
    ];

    for (const body of unusable) {
      const transport = new MockLlmTransport(body);
      const chosen = await agent(engine, transport).decideMove(board.state, legalMoves);
      expectSameMove(heuristic as Move, chosen);
    }
  });

  it("DecideMove_PlaysAForcedMoveWithoutAskingTheEndpoint", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const forced = [new Move(1000, engine.placeOfArc(PieceOwner.P1, 11))];

    const transport = new MockLlmTransport("not even JSON");
    const chosen = await agent(engine, transport).decideMove(board.state, forced);

    expectSameMove(forced[0], chosen);
    expect(transport.calls, "a forced move is not a decision").toBe(0);
  });

  it("DecideMove_DoesNotDecideWhenThereIsNothingToDecide", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const transport = new MockLlmTransport(chat('{"move_index": 0}'));

    const chosen = await agent(engine, transport).decideMove(board.state, []);

    expect(chosen).toBeNull();
    expect(transport.calls).toBe(0);
  });

  it("DecideMove_RethrowsWhenTheMatchIsCancelled", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const transport = new MockLlmTransport(chat('{"move_index": 0}'));
    const controller = new AbortController();
    controller.abort();

    await expect(
      agent(engine, transport).decideMove(board.state, legalMoves, controller.signal),
    ).rejects.toThrow();
    expect(transport.calls, "a cancelled match must not reach the network").toBe(0);
  });

  it("DecideMove_FallsBackWithoutAnEndpoint", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const subject = new LlmPlayerAgent(PieceOwner.P1, null, null, null, engine);
    const chosen = await subject.decideMove(board.state, legalMoves);

    expectSameMove(await new HeuristicPlayerAgent(PieceOwner.P1, null, engine)
      .decideMove(board.state, legalMoves) as Move, chosen);
    expect(subject.name).toBe("LLM NPC");
    expect(subject.owner).toBe(PieceOwner.P1);
  });

  // ------------------------------------------------------------------ the re-roll decision

  it("DecideReroll_UsesTheEndpointAnswer", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    expect(engine.canReroll(board.state), "the fixture has to offer a re-roll").toBe(true);

    const rerollTransport = new MockLlmTransport(chat('{"reroll": true, "reasoning": "want a better die"}'));
    expect(await agent(engine, rerollTransport).decideReroll(board.state)).toBe(
      RerollDecision.RerollActiveDie,
    );
    expect(rerollTransport.requests[0]).toContain("## Dice in spending order");

    const keepTransport = new MockLlmTransport(chat('{"reroll": false, "reasoning": "the sáhkku activates a soldier"}'));
    expect(await agent(engine, keepTransport).decideReroll(board.state)).toBe(
      RerollDecision.KeepDiceAndProceed,
    );
  });

  it("DecideReroll_FallsBackToTheHeuristicWhenTheRequestFails", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);

    const transport = new MockLlmTransport(chat("{}"));
    transport.failure = new Error("connection refused");
    const decision = await agent(engine, transport).decideReroll(board.state);

    expect(decision).toBe(await new HeuristicPlayerAgent(PieceOwner.P1, null, engine)
      .decideReroll(board.state));
  });

  it("DecideReroll_DoesNotAskWhenTheEngineOffersNoReroll", async () => {
    const engine = testEngine();
    const board = boardWithoutReroll(engine);
    expect(engine.canReroll(board.state)).toBe(false);

    const transport = new MockLlmTransport(chat('{"reroll": true}'));
    const decision = await agent(engine, transport).decideReroll(board.state);

    expect(decision).toBe(RerollDecision.KeepDiceAndProceed);
    expect(transport.calls, "a re-roll the engine would refuse is not worth a round trip").toBe(0);
  });

  // ------------------------------------------------------------------ observability

  it("Agent_LogsItsDecisionAndTheFallback", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);

    const decisions: string[] = [];
    const transport = new MockLlmTransport(chat('{"move_index": 1, "reasoning": "capturing the queen"}'));
    await agent(engine, transport, (line) => decisions.push(line)).decideMove(board.state, legalMoves);

    expect(decisions.length).toBe(1);
    expect(decisions[0]).toContain("NPC");
    expect(decisions[0]).toContain("capturing the queen");

    const failures: string[] = [];
    const failing = new MockLlmTransport(chat("{}"));
    failing.failure = new Error("boom");
    await agent(engine, failing, (line) => failures.push(line)).decideMove(board.state, legalMoves);

    expect(failures.length, "a fallback is reported exactly once").toBe(1);
    expect(failures[0]).toContain("boom");
    expect(failures[0]).toContain("heuristic");
  });

  // ------------------------------------------------------------------ the HTTP transport

  it("FetchTransport_PostsTheRequestBodyAndReturnsTheAnswer", async () => {
    const calls: Array<{ url: string; body: string; contentType: string | undefined }> = [];
    const fetchImpl: LlmFetch = (url, init) => {
      calls.push({ url, body: init.body, contentType: init.headers["content-type"] });
      return Promise.resolve(okResponse('{"answer": true}'));
    };
    const transport = new FetchLlmTransport(fetchImpl, 1000);

    expect(await transport.postChatCompletion("http://localhost:1/v1/chat/completions", '{"model":"m"}')).toBe(
      '{"answer": true}',
    );
    expect(transport.requestTimeoutMs).toBe(1000);
    expect(calls).toEqual([
      { url: "http://localhost:1/v1/chat/completions", body: '{"model":"m"}', contentType: "application/json" },
    ]);
  });

  it("FetchTransport_ThrowsOnANonSuccessStatus", async () => {
    const fetchImpl: LlmFetch = () =>
      Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error", text: () => Promise.resolve("") });
    const transport = new FetchLlmTransport(fetchImpl, 1000);

    await expect(transport.postChatCompletion("http://localhost:1/v1/chat/completions", "{}")).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it("FetchTransport_AbortsWhenTheDeadlineElapses", async () => {
    const fetchImpl: LlmFetch = (_url, init) =>
      new Promise<LlmHttpResponse>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("the request was aborted")), { once: true });
      });
    const transport = new FetchLlmTransport(fetchImpl, 20);

    await expect(transport.postChatCompletion("http://localhost:1/v1/chat/completions", "{}")).rejects.toThrow(
      /aborted/,
    );
  });

  it("DecideMove_FallsBackWhenTheTransportItselfTimesOut", async () => {
    const engine = testEngine();
    const board = boardWithChoices(engine);
    const legalMoves = engine.legalMoves(board.state);
    const fetchImpl: LlmFetch = (_url, init) =>
      new Promise<LlmHttpResponse>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("the request was aborted")), { once: true });
      });

    const transport = new FetchLlmTransport(fetchImpl, 20);
    const chosen = await agent(engine, transport).decideMove(board.state, legalMoves);

    expectSameMove(await new HeuristicPlayerAgent(PieceOwner.P1, null, engine)
      .decideMove(board.state, legalMoves) as Move, chosen);
  });
});

function okResponse(body: string): LlmHttpResponse {
  return { ok: true, status: 200, statusText: "OK", text: () => Promise.resolve(body) };
}

// ------------------------------------------------------------------ the shared config file

describe("LlmConfigFileTests", () => {
  const customEndpoint = "http://192.168.0.5:8080/v1/chat/completions";
  const customModel = "local-model";

  let sandbox: string;
  let previousEnvironment: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "sahkku-llm-config-"));
    previousEnvironment = process.env.SAHKKU_LLM_CONFIG;
    delete process.env.SAHKKU_LLM_CONFIG;
    LlmConfigFile.writableFallbackDirectory = null;
  });

  afterEach(() => {
    LlmConfigFile.writableFallbackDirectory = null;
    if (previousEnvironment === undefined) delete process.env.SAHKKU_LLM_CONFIG;
    else process.env.SAHKKU_LLM_CONFIG = previousEnvironment;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function writeConfig(directory: string, text: string): string {
    const path = join(directory, "llm-config.json");
    writeFileSync(path, text, "utf8");
    return path;
  }

  it("Load_MissingFile_ReturnsDefaultsWithoutThrowing", () => {
    const loaded = LlmConfigFile.load(join(sandbox, "not-there", "llm-config.json"));

    expect(loaded.endpoint).toBe(DefaultEndpoint);
    expect(loaded.model).toBe(DefaultModel);
  });

  it("Load_ReadsTheEndpointAndModel", () => {
    const path = writeConfig(sandbox, `{"endpoint":"${customEndpoint}","model":"${customModel}"}`);

    expect(LlmConfigFile.load(path)).toEqual({ endpoint: customEndpoint, model: customModel });
  });

  it("Load_BaseUrl_IsCompletedToTheChatCompletionsPath", () => {
    const path = writeConfig(sandbox, '{"endpoint":"http://localhost:1234/v1"}');

    const loaded = LlmConfigFile.load(path);

    expect(loaded.endpoint).toBe("http://localhost:1234/v1/chat/completions");
    expect(loaded.model, "a file without a model keeps the default").toBe(DefaultModel);
  });

  it("Load_MalformedOrWronglyTypedText_ReturnsDefaultsWithoutThrowing", () => {
    for (const text of [
      "{ this is not json ",
      '{"endpoint": 42, "model": ["x"], "extra": true}',
      '{"endpoint":"","model":"   "}',
    ]) {
      const path = writeConfig(sandbox, text);
      expect(LlmConfigFile.load(path), text).toEqual({ endpoint: DefaultEndpoint, model: DefaultModel });
    }
  });

  it("Save_WritesCleanJsonThatLoadsBack", () => {
    const path = join(sandbox, "nested", "llm-config.json");
    LlmConfigFile.save("http://localhost:1234/v1", "", path);

    expect(LlmConfigFile.serialize("http://localhost:1234/v1", "")).toBe(
      `{\n  "endpoint": "http://localhost:1234/v1/chat/completions",\n  "model": "${DefaultModel}"\n}\n`,
    );
    expect(LlmConfigFile.load(path)).toEqual({
      endpoint: "http://localhost:1234/v1/chat/completions",
      model: DefaultModel,
    });
  });

  it("LocateConfigFile_FollowsTheDocumentedDiscoveryOrder", () => {
    const explicit = join(sandbox, "explicit.json");
    expect(LlmConfigFile.locateConfigFile(explicit)).toBe(explicit);

    process.env.SAHKKU_LLM_CONFIG = join(sandbox, "from-environment.json");
    expect(LlmConfigFile.locateConfigFile()).toBe(join(sandbox, "from-environment.json"));
    expect(LlmConfigFile.locateConfigFile(explicit), "an explicit path always wins").toBe(explicit);
    delete process.env.SAHKKU_LLM_CONFIG;

    // The upward search walks the directory itself first, then every parent.
    const nested = join(sandbox, "a", "b");
    const found = writeConfig(sandbox, "{}");
    expect(LlmConfigFile.searchUpwards(nested)).toBe(found);
    expect(LlmConfigFile.locateConfigFile(null, nested)).toBe(found);
  });

  it("Save_RetriesInTheWritableFallbackDirectoryWhenTheRootIsUnwritable", () => {
    // A path whose parent is a file rather than a directory stands in for a root the install cannot
    // write to; the reference implementation recovers from it exactly the same way.
    const blocked = join(writeConfig(sandbox, "{}"), "llm-config.json");
    LlmConfigFile.writableFallbackDirectory = join(sandbox, "fallback");

    const saved = LlmConfigFile.save(customEndpoint, customModel, blocked);

    expect(saved).toBe(join(sandbox, "fallback", "llm-config.json"));
    expect(LlmConfigFile.load(null)).toEqual({ endpoint: customEndpoint, model: customModel });
  });

  it("Normalize_TrimsAndCompletesBothSettings", () => {
    expect(normalizeEndpoint("  http://localhost:1234/v1/chat/completions  ")).toBe(
      "http://localhost:1234/v1/chat/completions",
    );
    expect(normalizeEndpoint("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1/chat/completions");
    expect(normalizeEndpoint("http://localhost:1234")).toBe("http://localhost:1234/v1/chat/completions");
    expect(normalizeEndpoint("http://localhost:11434")).toBe("http://localhost:11434/v1/chat/completions");
    expect(normalizeEndpoint("http://localhost:11434/api/chat")).toBe("http://localhost:11434/api/chat");
    expect(normalizeEndpoint("")).toBe(DefaultEndpoint);
    expect(normalizeModel(" local-model ")).toBe("local-model");
    expect(normalizeModel(null)).toBe(DefaultModel);
  });
});
