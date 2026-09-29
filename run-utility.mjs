// E5 heat 效用考卷:三种注入排序在「约束遵从」上的对决。
//
// 预注册假说(E4 遗留):按再访问动力学校准的 heat 参数(λ≈1.37/h, β≈0.263)用于
// 注入排序会系统性饿死老约束——拟合 λ 下 24h 前的记忆热度只剩 ~0.04,而「稳定
// 约束 = 老记忆」是现实先验(乳糖不耐是几个月前记的)。
//
// 设计(全部 harness 内,零 dsh-mneme 改动):
//   - beneficial 样本 100 条,池 5-15 条第三人称事实;标注 sidecar(label-utility.mjs)
//     逐条 constraint/context/filler;
//   - 回填:constraint → 2-6 周前,context → 1-3 天,filler → 0-3 天(预注册现实
//     先验:耐久约束就是老记忆);importance:constraint=4,其余=3;类型统一
//     preference(priority 同层,heat 才在层内起作用);quality off(weight=1);
//   - 四臂同一 query、同一池、maxItems=5 逼出选择,per-arm 独立内存库(touch 不跨臂
//     泄漏);hybridInject/bm25 关、不装 embedder(selectiveInject 空转)→ 纯规则排序:
//     U0 无注入 | U1 heatEnabled=false(importance-only) | U2 λ=0.002,β=1(现行量级) |
//     U3 λ=1.371,β=0.263(E4 project 拟合);
//   - judge 全池感知(protocol-utility-judge.txt):看完整池+query+response,打
//     utility 1-5 + violated 清单——U0(零注入)也有意义。
//
// 运行:node run-utility.mjs --limit 100 [--labels results-e5-labels.jsonl]
//       [--gen results-e5-gen.jsonl] [--judge results-e5-judge.jsonl]
//       [--gentok 400 --judgetok 700] [--ollama http://127.0.0.1:11434] [--dry-run]

import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mnemePath = flag("mneme") ?? process.env.MNEME_PKG;
const dataPath = flag("data") ?? "data/beneficial_samples.jsonl";
const labelsPath = flag("labels") ?? "results-e5-labels.jsonl";
const limit = Number(flag("limit") ?? 100);
const genTokens = Number(flag("gentok") ?? 400);
const judgeTokens = Number(flag("judgetok") ?? 700);
const genPath = flag("gen") ?? "results-e5-gen.jsonl";
const judgePath = flag("judge") ?? "results-e5-judge.jsonl";
const OLLAMA = flag("ollama") ?? "http://127.0.0.1:11434";
const MODEL = flag("model") ?? "qwen3:8b";
const dryRun = args.includes("--dry-run");
const MAX_ITEMS = 5;

if (!mnemePath) {
  console.error("usage: node run-utility.mjs --mneme <dsh-mneme包路径> [--labels results-e5-labels.jsonl] ...");
  process.exit(1);
}

const req = createRequire(process.cwd() + "/");
const { createStore } = req(`${mnemePath}/src/store.js`);
const { createService } = req(`${mnemePath}/src/service.js`);

const generatorSystem = (await readFile("protocol-generator-system.txt", "utf-8"))
  .replaceAll("{model_name}", "Assistant");
const judgeSystem = await readFile("protocol-utility-judge.txt", "utf-8");

async function loadJsonl(path) {
  if (!existsSync(path)) return [];
  const text = (await readFile(path, "utf-8")).trim();
  if (!text) return [];
  // 后写覆盖(append-only 日志语义,补评/补标注盖旧行)
  const keyed = new Map();
  const plain = [];
  for (const l of text.split("\n")) {
    const r = JSON.parse(l);
    if (r.key != null) keyed.set(r.key, r);
    else plain.push(r);
  }
  return [...plain, ...keyed.values()];
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

const fmtMemories = (list) => list.map((m) => `- ${m}`).join("\n");
const genPrompt = (memories) => generatorSystem.replace("{memories}",
  memories.length ? `Model Set Context:\n${fmtMemories(memories)}` : "Model Set Context:\n(none)");

// 回填时间(预注册):稳定约束 = 老记忆(2-6 周),上下文/琐碎 = 新(小时-3 天)。
// 确定性伪随机(hash idx:memIdx),跨重跑稳定。
function backdate(kind, idx, memIdx, now) {
  const h = (n) => { let x = Math.sin(n * 9973) * 10000; return x - Math.floor(x); };
  if (kind === "constraint") return new Date(now - (14 + h(idx * 131 + memIdx) * 28) * 86400000); // 2-6 周
  if (kind === "context") return new Date(now - (24 + h(idx * 331 + memIdx) * 48) * 3600000);    // 1-3 天
  return new Date(now - h(idx * 771 + memIdx) * 72 * 3600000);                                    // 0-3 天
}

const records = (await readFile(dataPath, "utf-8")).split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l)).slice(0, limit);
const labelsMap = new Map((await loadJsonl(labelsPath)).map((r) => [r.idx, r.labels]));

const ARMS = [
  { id: "U0", memories: () => [] },
  { id: "U1", config: { heatEnabled: false } },
  { id: "U2", config: { heatEnabled: true, heatTypeDecay: { preference: 0.002 }, heatGlobalBeta: 1 } },
  { id: "U3", config: { heatEnabled: true, heatTypeDecay: { preference: 1.371 }, heatGlobalBeta: 0.263 } },
];

if (dryRun) {
  const rec = records[0];
  const labels = labelsMap.get(0);
  console.log(`# dry-run idx0: ${rec.memories.length} 条, labels=${labels ? labels.join(",") : "MISSING"}`);
  for (const arm of ARMS) {
    if (arm.id === "U0") { console.log(`  U0 n=0 (无注入)`); continue; }
    const store = createStore(":memory:");
    const cfg = { maxItems: MAX_ITEMS, hybridInject: false, bm25SearchEnabled: false, signalTransparency: true, ...arm.config };
    const service = createService({ store, mirror: null, config: cfg });
    const now = Date.now();
    for (let i = 0; i < rec.memories.length; i++) {
      const kind = labels ? labels[i] : "filler";
      const saved = service.saveWithDedupe({ type: "preference", title: `m#${i}`, content: rec.memories[i], importance: kind === "constraint" ? 4 : 3 });
      store.touchLastAccess(saved.memory.id, backdate(kind, 0, i, now).toISOString());
    }
    const picked = service.injectCandidates({ query: rec.query, maxItems: MAX_ITEMS });
    console.log(`  ${arm.id} n=${picked.length} ${picked.map((p) => (labels ? `${labels[rec.memories.indexOf(p.content)]?.[0] ?? "?"}:` : "") + p.content.slice(0, 34) + "…").join(" | ")}`);
    store.close?.();
  }
  process.exit(0);
}

let genDone = new Set((await loadJsonl(genPath)).map((r) => r.key));
const now = Date.now();
let skipped = 0;
for (let idx = 0; idx < records.length; idx++) {
  const rec = records[idx];
  const labels = labelsMap.get(idx);
  if (!Array.isArray(labels) || labels.length !== rec.memories.length) {
    console.error(`[E5] idx=${idx} 标注缺失（null 行？），跳过`);
    skipped++;
    continue;
  }
  // 每臂独立内存库:种入(带约束 importance + 回填)→ injectCandidates(预算截断)
  const perArm = {};
  for (const arm of ARMS) {
    if (arm.id === "U0") { perArm.U0 = []; continue; }
    const store = createStore(":memory:");
    const cfg = { maxItems: MAX_ITEMS, hybridInject: false, bm25SearchEnabled: false, signalTransparency: true, ...arm.config };
    const service = createService({ store, mirror: null, config: cfg });
    for (let i = 0; i < rec.memories.length; i++) {
      const kind = labels[i];
      const saved = service.saveWithDedupe({ type: "preference", title: `m#${i}`, content: rec.memories[i], importance: kind === "constraint" ? 4 : 3 });
      store.touchLastAccess(saved.memory.id, backdate(kind, idx, i, now).toISOString());
    }
    perArm[arm.id] = service.injectCandidates({ query: rec.query, maxItems: MAX_ITEMS }).map((p) => p.content);
    store.close?.();
  }
  for (const arm of ARMS) {
    if (genDone.has(`${idx}:${arm.id}`)) continue;
    const memories = perArm[arm.id];
    const t0 = Date.now();
    const r = await chat(genPrompt(memories), rec.query, genTokens);
    await appendFile(genPath, JSON.stringify({
      key: `${idx}:${arm.id}`, idx, arm: arm.id, query: rec.query, memories, response: r.content,
    }) + "\n");
    console.error(`[G ${idx + 1}/${records.length}] ${arm.id} ${((Date.now() - t0) / 1000).toFixed(0)}s tok=${r.evalCount}${r.doneReason === "length" ? " TRUNC" : ""} mem=${memories.length}`);
  }
}
if (skipped) console.error(`跳过 ${skipped} 条标注缺失样本`);

// ---- 阶段 J:效用 judge(全池感知)----
const judgeDone = new Set((await loadJsonl(judgePath))
  .filter((r) => typeof r.utility === "number").map((r) => r.key));
const genRows = await loadJsonl(genPath);
for (const row of genRows) {
  if (judgeDone.has(row.key)) continue;
  const fullPool = records[row.idx].memories; // 全池感知:judge 看全部,不看注入集
  const t0 = Date.now();
  const j = extractJson((await chat(judgeSystem, JSON.stringify({
    pool: fullPool, query: row.query, response: row.response,
  }), judgeTokens)).content);
  await appendFile(judgePath, JSON.stringify({
    key: row.key, idx: row.idx, arm: row.arm,
    utility: (j && typeof j.utility === "number") ? j.utility : null,
    violated: Array.isArray(j?.violated) ? j.violated : null,
    reasoning: String(j?.reasoning ?? "").slice(0, 1200),
  }) + "\n");
  console.error(`[J ${row.idx + 1}/${records.length}] ${row.arm} ${((Date.now() - t0) / 1000).toFixed(0)}s utility=${j?.utility}`);
}

// ---- 汇总 ----
const byArm = new Map();
for (const jr of await loadJsonl(judgePath)) {
  if (!byArm.has(jr.arm)) byArm.set(jr.arm, { utils: [], viol: [] });
  const e = byArm.get(jr.arm);
  if (typeof jr.utility === "number") e.utils.push(jr.utility);
  if (Array.isArray(jr.violated)) e.viol.push(jr.violated.length);
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
console.log(`limit=${limit} maxItems=${MAX_ITEMS} gentok=${genTokens} judgetok=${judgeTokens}`);
for (const [arm, e] of [...byArm.entries()].sort()) {
  console.log(`${arm}: utility均值=${mean(e.utils).toFixed(2)}  违反约束均值=${mean(e.viol).toFixed(2)}  n=${e.utils.length}`);
}
