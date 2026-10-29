import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HeuristicPlayerAgent } from "../src/agents/heuristic";
import { evaluatePosition, queenThreats } from "../src/agents/evaluation";
import { type HeuristicDifficulty, positionKey } from "../src/agents/search";
import type { PlayerAgent } from "../src/agents/types";
import { MatchConfig, MatchRunner, SeededRandomSource } from "../src/cli/match-runner";
import { GameState, Move, PieceOwner, WinReason } from "../src/rules/domain";
import { RulesEngine } from "../src/rules/engine";
import { loadShippedRuleset } from "../src/rules/ruleset";
import { LegacyHeuristicAgent } from "../tests/helpers/legacy-agent";

type Opponent = HeuristicDifficulty | "legacy" | "hunter";
type Job = {
  a: Opponent; b: Opponent; seed: number; swapped: boolean; evenOdds: boolean; maxTurns: number;
};
type Result = Job & {
  score: number; queenLoss: boolean; exhaustionWin: boolean; turns: number;
  nodes: number; decisions: number; limited: number; depths: Record<string, number>;
  latencies: number[]; error: string | null;
};

/** Deterministic adversary: looks for a winning sequence, then creates deliberate queen pressure. */
class QueenHunter extends LegacyHeuristicAgent {
  constructor(owner: PieceOwner, private readonly rulesEngine: RulesEngine) {
    super(owner, "Queen hunter", rulesEngine);
  }
  override async decideMove(state: GameState, moves: readonly Move[]): Promise<Move | null> {
    const winning = new Map<string, boolean>();
    const canWin = (s: GameState): boolean => {
      if (s.gameOver) return s.winner === this.owner;
      if (s.isRollPhase || s.currentPlayer !== this.owner) return false;
      const key = positionKey(s);
      const cached = winning.get(key);
      if (cached != null) return cached;
      for (const move of this.rulesEngine.legalMoves(s)) {
        const clone = s.clone();
        this.rulesEngine.applyMove(clone, move);
        if (canWin(clone)) {
          winning.set(key, true);
          return true;
        }
      }
      winning.set(key, false);
      return false;
    };
    let best = moves[0] ?? null;
    let score = -Infinity;
    for (const move of moves) {
      const clone = state.clone();
      this.rulesEngine.applyMove(clone, move);
      if (canWin(clone)) return move;
      const value = evaluatePosition(this.rulesEngine, clone, this.owner) +
        queenThreats(this.rulesEngine, clone,
          this.owner === PieceOwner.P1 ? PieceOwner.P2 : PieceOwner.P1) * 250;
      if (value > score) { score = value; best = move; }
    }
    return best;
  }
}

async function play(job: Job): Promise<Result> {
  const engine = new RulesEngine(loadShippedRuleset());
  const result: Result = {
    ...job, score: 0, queenLoss: false, exhaustionWin: false, turns: 0,
    nodes: 0, decisions: 0, limited: 0, depths: {}, latencies: [], error: null,
  };
  const create = (kind: Opponent, owner: PieceOwner): PlayerAgent => {
    if (kind === "legacy") return new LegacyHeuristicAgent(owner, null, engine);
    if (kind === "hunter") return new QueenHunter(owner, engine);
    return new HeuristicPlayerAgent(owner, null, engine, {
      difficulty: kind, random: new SeededRandomSource(job.seed * 31 + owner),
      log: message => { result.error = message; },
      onSearch: (d, duration) => {
        result.nodes += d.nodes;
        result.decisions++;
        result.limited += Number(d.budgetExhausted);
        const key = `${kind}:${d.completedTurns}`;
        result.depths[key] = (result.depths[key] ?? 0) + 1;
        result.latencies.push(duration);
      },
    });
  };
  const owner = job.swapped ? PieceOwner.P2 : PieceOwner.P1;
  const a = create(job.a, owner);
  const b = create(job.b, job.swapped ? PieceOwner.P1 : PieceOwner.P2);
  const config = new MatchConfig();
  config.seed = job.seed;
  config.useRandomSeed = false;
  config.evenOdds = job.evenOdds;
  config.maxHalfMoves = job.maxTurns;
  config.turnTimeoutMs = 0;
  const match = await new MatchRunner(engine, job.swapped ? b : a, job.swapped ? a : b)
    .runMatch(0, config);
  result.error = match.errorMessage ?? result.error;
  result.score = match.winner === PieceOwner.None ? 0.5 : Number(match.winner === owner);
  result.queenLoss = match.winner !== owner && match.winReason === WinReason.QueenCaptured;
  result.exhaustionWin = match.winner === owner && match.winReason === WinReason.OpponentSoldiersExhausted;
  result.turns = match.totalHalfMoves;
  return result;
}

if (process.env.SAHKKU_STRATEGY_JOB) {
  const job = JSON.parse(process.env.SAHKKU_STRATEGY_JOB) as Job;
  console.log(JSON.stringify(await play(job)));
} else {
  const flags = new Map<string, string>();
  const allowed = ["--pairs", "--seed", "--matchup", "--workers", "--output", "--max-turns"];
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!allowed.includes(process.argv[i]) || !process.argv[i + 1]) {
      throw new Error(`Expected ${allowed.join(", ")} followed by a value.`);
    }
    flags.set(process.argv[i], process.argv[i + 1]);
  }
  const integer = (flag: string, fallback: number, min: number): number => {
    const text = flags.get(flag);
    const value = text == null ? fallback : Number(text);
    if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${flag}.`);
    return value;
  };
  const pairs = integer("--pairs", 200, 1);
  const seed = integer("--seed", 20261101, 0);
  const maxTurns = integer("--max-turns", 1000, 1);
  const policyHash = createHash("sha256");
  for (const path of [
    "../src/agents/search.ts", "../src/agents/evaluation.ts", "../src/agents/heuristic.ts",
    "../src/rules/SahkkuRules.json", "./StrategyBench.ts",
  ]) policyHash.update(readFileSync(new URL(path, import.meta.url)));
  const revision = policyHash.digest("hex");
  const workers = Math.min(integer("--workers", 4, 1), availableParallelism());
  const matchups: [Opponent, Opponent][] = [
    ["medium", "easy"], ["hard", "medium"],
    ["easy", "hunter"], ["medium", "hunter"], ["hard", "hunter"],
    ["easy", "legacy"], ["medium", "legacy"], ["hard", "legacy"],
  ];
  const selection = flags.get("--matchup") ?? "all";
  const selected = selection === "all" ? matchups :
    matchups.filter(([a, b]) => `${a}-${b}` === selection);
  if (!selected.length) throw new Error(`Unknown matchup '${selection}'.`);
  const jobs = selected.flatMap(([a, b]) => Array.from({ length: pairs }, (_, i) =>
    [false, true].flatMap(evenOdds => [false, true].map(swapped =>
      ({ a, b, seed: seed + i, evenOdds, swapped, maxTurns })))).flat());
  const results: Result[] = [];
  const active = new Set<ChildProcess>();
  let next = 0;
  const output = flags.get("--output");
  function report() {
    return selected.map(([a, b]) => {
      const games = results.filter(r => r.a === a && r.b === b);
      const blocks = new Map<number, number[]>();
      for (const r of games) {
        const scores = blocks.get(r.seed) ?? [];
        scores.push(r.score);
        blocks.set(r.seed, scores);
      }
      const blockMeans = [...blocks.values()].filter(b => b.length === 4)
        .map(b => b.reduce((sum, v) => sum + v, 0) / b.length);
      const samples: number[] = [];
      const random = new SeededRandomSource(seed);
      if (blockMeans.length) for (let i = 0; i < 2000; i++) {
        let total = 0;
        for (let j = 0; j < blockMeans.length; j++) total += blockMeans[random.nextInt(0, blockMeans.length)];
        samples.push(total / blockMeans.length);
      }
      samples.sort((x, y) => x - y);
      const latencies = games.flatMap(r => r.latencies).sort((x, y) => x - y);
      const rate = games.reduce((sum, r) => sum + r.score, 0) / games.length;
      return {
        a, b, games: games.length, score: rate,
        wins: games.filter(r => r.score === 1).length,
        draws: games.filter(r => r.score === 0.5).length,
        standardScore: mean(games.filter(r => !r.evenOdds).map(r => r.score)),
        evenOddsScore: mean(games.filter(r => r.evenOdds).map(r => r.score)),
        interval95: samples.length ? [
          samples[Math.floor(samples.length * 0.025)], samples[Math.floor(samples.length * 0.975)],
        ] : null,
        queenLosses: games.filter(r => r.queenLoss).length,
        exhaustionWins: games.filter(r => r.exhaustionWin).length,
        nodes: games.reduce((sum, r) => sum + r.nodes, 0),
        completedDepths: games.reduce<Record<string, number>>((acc, r) => {
          for (const [depth, count] of Object.entries(r.depths)) acc[depth] = (acc[depth] ?? 0) + count;
          return acc;
        }, {}),
        budgetLimits: games.reduce((sum, r) => sum + r.limited, 0),
        latencyMs: { p50: latencies[Math.floor(latencies.length / 2)], p95: latencies[Math.floor(latencies.length * 0.95)] },
        releaseGate: maxTurns >= 1000 && games.length >= 800 && blockMeans.length >= 200 &&
          rate >= 0.6 && samples[Math.floor(samples.length * 0.025)] > 0.5 &&
          games.every(r => !r.error),
        errors: games.filter(r => r.error).map(r => r.error),
      };
    });
  }
  const save = (): void => {
    if (output) writeFileSync(output, JSON.stringify({
      seed, pairs, maxTurns, revision, report: report(), results,
    }, null, 2));
  };
  try {
    await Promise.all(Array.from({ length: workers }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const result = await new Promise<Result>((resolve, reject) => {
          const worker = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
            env: { ...process.env, SAHKKU_STRATEGY_JOB: JSON.stringify(job) },
            stdio: ["ignore", "pipe", "pipe"],
          });
          active.add(worker);
          let stdout = "";
          let stderr = "";
          worker.stdout.on("data", data => { stdout += String(data); });
          worker.stderr.on("data", data => { stderr += String(data); });
          worker.once("error", reject);
          worker.once("close", code => {
            active.delete(worker);
            if (code !== 0) reject(new Error(`Strategy worker exited with code ${code}: ${stderr}`));
            else {
              try { resolve(JSON.parse(stdout) as Result); }
              catch (error) { reject(error); }
            }
          });
        });
        results.push(result);
        save();
        console.error(`${results.length}/${jobs.length}: ${job.a}-${job.b}, seed ${job.seed}, score ${result.score}`);
        if (result.error) throw new Error(result.error);
      }
    }));
  } finally {
    for (const worker of active) worker.kill();
  }
  console.log(JSON.stringify({ seed, pairs, maxTurns, revision, report: report() }, null, 2));
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
