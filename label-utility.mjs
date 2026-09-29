// 效用考卷标注(E5 阶段一):beneficial 样本池无逐条「有用约束」标注,先由 LLM
// 按 query 逐条分类 constraint(任务必须遵从的耐久约束:饮食/预算/格式/受众)/
// context(任务支撑上下文)/filler(无关干扰),落 sidecar。标注驱动回填时间
// (constraint 老 / filler 新)与 importance(constraint=4),也当效用分析的 ground
// truth。断点续跑安全;坏输出重试一次,仍坏记 null(该样本四臂全跳过)。
//
// 运行:node label-utility.mjs [--limit 100] [--model qwen3:8b] [--data data/beneficial_samples.jsonl]
//       [--out results-e5-labels.jsonl] [--ollama http://127.0.0.1:11434]

import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataPath = flag("data") ?? "data/beneficial_samples.jsonl";
const outPath = flag("out") ?? "results-e5-labels.jsonl";
const limit = Number(flag("limit") ?? 100);
const OLLAMA = flag("ollama") ?? "http://127.0.0.1:11434";
const MODEL = flag("model") ?? "qwen3:8b";
const MAXTOK = Number(flag("maxtok") ?? 700);

const system = `You label memories for a personal-memory system.

Given a user request (query) and a pool of first-person memories, classify EACH memory as exactly one of:

- "constraint": a durable personal requirement or limitation the response to this query MUST respect — dietary restrictions, allergies, budget caps, quantity/format/style requirements, audience considerations. (中文口径:任务必须遵从的耐久约束)
- "context": a task-relevant supporting fact that shapes the answer but is not a hard requirement — the occasion, the people involved, recent events, plans. (任务支撑上下文)
- "filler": unrelated noise — facts with no bearing on this request. (无关干扰)

Rules:
- A memory can be "context" for one query and "filler" for another — judge against THIS query.
- Dietary/allergy/budget facts are almost always "constraint" when the query involves food, gifts, purchases, or planning.
- When torn between "constraint" and "context", choose "constraint" only if violating it would make the response materially worse for the user.

Respond with EXACTLY one line per memory, in order, no extra text:
1: constraint
2: filler
3: context
(Line number, colon, one label. The number of lines must equal the number of memories.)`;

const records = (await readFile(dataPath, "utf-8")).split("\n").filter((l) => l.trim())
  .map((l) => JSON.parse(l)).slice(0, limit);

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

// 行格式解析("N: label" 每行一条)——比长 JSON 数组抗造得多(qwen3:8b 首跑 42%
// 的数组输出长度/值写坏,行格式天然按行对齐、无需整体长度正确)
function extractLines(content, count) {
  const out = [];
  for (const m of content.matchAll(/(^|\n)\s*(\d+)\s*[:.)]\s*(constraint|context|filler)\b/gi)) {
    out[Number(m[2]) - 1] = m[3].toLowerCase();
  }
  return out.length === count && out.every((x) => x) ? out : null;
}

const done = new Set();
if (existsSync(outPath)) {
  for (const l of (await readFile(outPath, "utf-8")).split("\n").filter(Boolean)) {
    // null 行不算完成——补标注要重做它们(首跑 42% 失败率 + null 挡重跑的双重教训)
    try { const r = JSON.parse(l); if (r.key != null && Array.isArray(r.labels)) done.add(r.key); } catch {}
  }
}

const VALID = new Set(["constraint", "context", "filler"]);
let fixed = 0;
for (let idx = 0; idx < records.length; idx++) {
  if (done.has(String(idx))) continue;
  const rec = records[idx];
  const t0 = Date.now();
  const user = JSON.stringify({ query: rec.query, memories: rec.memories });
  const ok = (ls) => Array.isArray(ls) && ls.length === rec.memories.length && ls.every((x) => VALID.has(x));
  // 三级解析:行格式 → 带精确计数提醒的重试行格式(打破温度 0 的确定性)→ JSON 兜底
  let labels = extractLines((await chat(system, user, MAXTOK)).content, rec.memories.length);
  if (!ok(labels)) {
    const retryUser = user + `\n\nIMPORTANT: there are exactly ${rec.memories.length} memories. Output exactly ${rec.memories.length} lines, one per memory, in order.`;
    labels = extractLines((await chat(system, retryUser, MAXTOK)).content, rec.memories.length);
  }
  if (!ok(labels)) {
    labels = (extractJson((await chat(system, user, MAXTOK)).content) || {}).labels;
  }
  if (!ok(labels)) {
    console.error(`[L ${idx + 1}/${records.length}] BAD LABELS，三级解析全失败，记 null`);
    await appendFile(outPath, JSON.stringify({ key: String(idx), idx, labels: null }) + "\n");
    continue;
  }
  await appendFile(outPath, JSON.stringify({ key: String(idx), idx, labels }) + "\n");
  console.error(`[L ${idx + 1}/${records.length}] ${((Date.now() - t0) / 1000).toFixed(1)}s ${labels.filter((x) => x === "constraint").length}c/${labels.filter((x) => x === "context").length}x/${labels.filter((x) => x === "filler").length}f`);
}
console.error(`done，重试修复 ${fixed} 条`);
