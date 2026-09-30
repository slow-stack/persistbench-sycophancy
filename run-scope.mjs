// E7 strictScope 考卷:三臂(scope off / 软档 / 硬墙)× 合成多用户池,测跨用户泄露。
// 设计见 plan(2026-09-30)与 gen-scope-bench.py 头注。
//   S2 无标注(scopeEnabled=false,现行默认) | S1 explicit+软档(strictScope=false)
//   S0 explicit+硬墙(strictScope=true)
// 机制事实(service.js:1533):注入通道只有 strictScope===true 才过滤,软加权只存在于
// 检索通道——S1 的注入集应与 S2 逐条相同,这是本实验要量化的「软档不护注入通道」。
// judge 全池感知(看 x_constraints + y_private,盲注入集);泄露另有机械口径(marker 词边界)。
// 机械读数:searchMemories 三臂 topK(检索通道软加权 ×0.5 的实效)单独落 --search 文件。
//
// 用法: node run-scope.mjs --mneme <dsh-mneme包路径> --bench scope_bench.jsonl --limit 80
//        --gen results-e7-gen.jsonl --judge results-e7-judge.jsonl --search results-e7-search.jsonl
// 断点续跑:append + seen-set(与 run-utility 同款)。

import { readFile, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mnemePath = flag("mneme") ?? process.env.MNEME_PKG;
const benchPath = flag("bench") ?? "data/scope_bench.jsonl";
const limit = Number(flag("limit") ?? 100);
const genTokens = Number(flag("gentok") ?? 400);
const judgeTokens = Number(flag("judgetok") ?? 700);
const genPath = flag("gen") ?? "results-e7-gen.jsonl";
const judgePath = flag("judge") ?? "results-e7-judge.jsonl";
const searchPath = flag("search") ?? "results-e7-search.jsonl";
const OLLAMA = flag("ollama") ?? "http://127.0.0.1:11434";
const MODEL = flag("model") ?? "qwen3:8b";
const dryRun = args.includes("--dry-run");
const MAX_ITEMS = 5;

if (!mnemePath) {
  console.error("usage: node run-scope.mjs --mneme <dsh-mneme包路径> [--bench scope_bench.jsonl] ...");
  process.exit(1);
}

const req = createRequire(process.cwd() + "/");
const { createStore } = req(`${mnemePath}/src/store.js`);
const { createService } = req(`${mnemePath}/src/service.js`);

const generatorSystem = (await readFile("protocol-generator-system.txt", "utf-8"))
  .replaceAll("{model_name}", "Assistant");
const judgeSystem = await readFile("protocol-privacy-judge.txt", "utf-8");

function loadJsonl(path) {
  return readFile(path, "utf-8").then((text) => text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : []);
}

function chat(system, user, maxTokens) {
  const payload = JSON.stringify({
    model: MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    stream: false,
    think: false,
    keep_alive: "2h",
    options: { num_ctx: 16384, num_predict: maxTokens, temperature: 0 },
  });
  return new Promise((resolve, reject) => {
    const r = http.request(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`ollama ${res.statusCode}: ${data.slice(0, 200)}`));
        try {
          const j = JSON.parse(data);
          resolve({ content: j.message.content, evalCount: j.eval_count ?? 0 });
        } catch { reject(new Error(`bad json: ${data.slice(0, 200)}`)); }
      });
    });
    r.on("error", reject);
    r.write(payload);
    r.end();
  });
}

function extractJson(content) {
  const s = content.trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/s);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  const cb = s.match(/```(?:json)?\s*(\{.*?\})\s*```/s);
  if (cb) { try { return JSON.parse(cb[1]); } catch {} }
  return null;
}

const IMPORTANCE = { "x-constraint": 4, "y-private": 4, "x-context": 3, filler: 3 };
const SCOPE_X = { agent_scope: "agent-x", workspace_scope: null };

// 三臂:S2 现行默认(不传 scope);S1 explicit 标注 + 软档;S0 explicit 标注 + 硬墙。
const ARMS = [
  { id: "S2", seedScope: false, config: { heatEnabled: false, scopeEnabled: false, strictScope: false }, passScope: false },
  { id: "S1", seedScope: true, config: { heatEnabled: false, scopeEnabled: true, strictScope: false }, passScope: true },
  { id: "S0", seedScope: true, config: { heatEnabled: false, scopeEnabled: true, strictScope: true }, passScope: true },
];

const records = (await loadJsonl(benchPath)).slice(0, limit);
console.error(`bench=${benchPath} limit=${records.length} arms=${ARMS.map((a) => a.id).join("/")}`);

// 种库:每臂独立内存库。返回 {picked, searchRows, roleById}
function seedAndPick(idx, rec, arm) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { maxItems: MAX_ITEMS, hybridInject: false, bm25SearchEnabled: false, signalTransparency: true, ...arm.config } });
  const roleById = new Map();
  for (let i = 0; i < rec.memories.length; i++) {
    const m = rec.memories[i];
    const payload = { type: "preference", title: `m#${i}`, content: m.content, importance: IMPORTANCE[m.role] ?? 3 };
    if (arm.seedScope) {
      if (m.owner === "x") { payload.agent_scope = "agent-x"; payload.agent_scope_source = "explicit"; }
      if (m.owner === "y") { payload.agent_scope = "agent-y"; payload.agent_scope_source = "explicit"; }
    }
    const saved = service.saveWithDedupe(payload);
    roleById.set(saved.memory.id, m.role);
  }
  const injOpts = { query: rec.query, maxItems: MAX_ITEMS };
  if (arm.passScope) injOpts.scope = SCOPE_X;
  const picked = service.injectCandidates(injOpts).map((p) => p.content);
  const searchRows = null; // 检索通道读数单独跑(异步)
  store.close?.();
  return { picked, roleById, store: null, service: null };
}

// 检索通道机械读数:三臂 topK 里 y-private 的排名(软加权 ×0.5 的实效)
async function searchReadout(rec, arm) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { hybridInject: false, bm25SearchEnabled: false, ...arm.config } });
  const roleById = new Map();
  for (let i = 0; i < rec.memories.length; i++) {
    const m = rec.memories[i];
    const payload = { type: "preference", title: `m#${i}`, content: m.content, importance: IMPORTANCE[m.role] ?? 3 };
    if (arm.seedScope) {
      if (m.owner === "x") { payload.agent_scope = "agent-x"; payload.agent_scope_source = "explicit"; }
      if (m.owner === "y") { payload.agent_scope = "agent-y"; payload.agent_scope_source = "explicit"; }
    }
    const saved = service.saveWithDedupe(payload);
    roleById.set(saved.memory.id, m.role);
  }
  const res = await service.searchMemories(rec.query, { scope: arm.passScope ? SCOPE_X : null, topK: 10, recordRecall: false });
  const rows = res.map((m, rank) => ({ rank: rank + 1, role: roleById.get(m.id) ?? "?", score: m.score ?? null }));
  store.close?.();
  return rows;
}

if (dryRun) {
  const rec = records[0];
  for (const arm of ARMS) {
    const { picked } = seedAndPick(0, rec, arm);
    const injY = picked.filter((c) => rec.y_private.includes(c)).length;
    const injX = picked.filter((c) => rec.x_constraints.includes(c)).length;
    console.log(`  ${arm.id}: 注入 ${picked.length} 条 | x-constraint ${injX} | y-private ${injY}`);
    const sr = await searchReadout(rec, arm);
    const yRanks = sr.filter((r) => r.role === "y-private").map((r) => r.rank);
    console.log(`      search top10 y-private 排名: ${yRanks.join(",") || "无"}`);
  }
  process.exit(0);
}

// ---- 阶段 1:机械读数(注入集 + 检索通道;零 LLM,断点安全)----
const searchDone = new Set((await loadJsonl(searchPath).catch(() => [])).map((r) => r.key));
for (let idx = 0; idx < records.length; idx++) {
  const rec = records[idx];
  for (const arm of ARMS) {
    const key = `${idx}:${arm.id}`;
    if (searchDone.has(key)) continue;
    const { picked } = seedAndPick(idx, rec, arm);
    const sr = await searchReadout(rec, arm);
    await appendFile(searchPath, JSON.stringify({
      key, idx, arm: arm.id,
      injected: picked,
      injected_y: picked.filter((c) => rec.y_private.includes(c)).length,
      injected_x: picked.filter((c) => rec.x_constraints.includes(c)).length,
      search: sr,
    }) + "\n");
  }
  if (idx % 20 === 19) console.error(`[mech ${idx + 1}/${records.length}]`);
}

// ---- 阶段 2:G 生成(四臂注入 → 回复)----
const genDone = new Set((await loadJsonl(genPath).catch(() => [])).map((r) => r.key));
const mechRows = await loadJsonl(searchPath);
const mechByKey = new Map(mechRows.map((r) => [r.key, r]));
for (let idx = 0; idx < records.length; idx++) {
  const rec = records[idx];
  for (const arm of ARMS) {
    const key = `${idx}:${arm.id}`;
    if (genDone.has(key)) continue;
    const mech = mechByKey.get(key);
    if (!mech) { console.error(`[E7] ${key} 机械读数缺失,跳过`); continue; }
    const t0 = Date.now();
    const memories = mech.injected;
    const g = await chat(generatorSystem.replace("{memories}",
      memories.length ? `Model Set Context:\n${memories.map((m) => `- ${m}`).join("\n")}` : "Model Set Context:\n(none)"), rec.query, genTokens);
    await appendFile(genPath, JSON.stringify({
      key, idx, arm: arm.id, query: rec.query, memories, response: g.content,
    }) + "\n");
    console.error(`[G ${idx + 1}/${records.length}] ${arm.id} ${((Date.now() - t0) / 1000).toFixed(0)}s tok=${g.evalCount} mem=${memories.length}`);
  }
}

// ---- 阶段 3:J 泄露 judge(全池感知,盲注入集)----
const judgeDone = new Set((await loadJsonl(judgePath).catch(() => [])).map((r) => r.key));
const genRows = await loadJsonl(genPath);
for (const row of genRows) {
  if (judgeDone.has(row.key)) continue;
  const rec = records[row.idx];
  const t0 = Date.now();
  const j = extractJson((await chat(judgeSystem, JSON.stringify({
    query: row.query, response: row.response,
    x_constraints: rec.x_constraints, y_private: rec.y_private,
  }), judgeTokens)).content);
  await appendFile(judgePath, JSON.stringify({
    key: row.key, idx: row.idx, arm: row.arm,
    severity: j?.severity ?? null,
    confusion: j?.confusion ?? null,
    utility: j?.utility ?? null,
    leaked: Array.isArray(j?.leaked) ? j.leaked : [],
  }) + "\n");
  console.error(`[J] ${row.key} sev=${j?.severity} util=${j?.utility} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

console.log(`limit=${limit} arms=${ARMS.length} gentok=${genTokens} judgetok=${judgeTokens}`);
