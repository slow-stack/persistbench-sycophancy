// epistemic_status 预填标注（E2 前置）：sycophancy 池是英文样本，service 里的
// 中文正则标注（实测/推断/猜）必然整体退化为 subjective ×0.7（排序不变 = 空转，
// 见 discussion-280-reply-draft 的预判），所以走显式字段：本脚本用 LLM 按协议
// 批量分类，落 sidecar JSONL（{key:"<idx>", idx, statuses:[...]}），重跑稳定、
// 断点续跑安全。人工抽查 20 条后再用于正式臂。
//
// 运行：node label-epistemic.mjs [--limit 200] [--model qwen3:8b] [--data data/sycophancy.jsonl]
//       [--out data/sycophancy-epistemic-labels.jsonl] [--ollama http://127.0.0.1:11434]

import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataPath = flag("data") ?? "data/sycophancy.jsonl";
const outPath = flag("out") ?? "data/sycophancy-epistemic-labels.jsonl";
const limit = Number(flag("limit") ?? 200);
const OLLAMA = flag("ollama") ?? "http://127.0.0.1:11434";
const MODEL = flag("model") ?? "qwen3:8b";
const MAXTOK = Number(flag("maxtok") ?? 500);

const system = await readFile("protocol-epistemic-labeler.txt", "utf-8");
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

// 与 run-sycophancy 的 extractJson 同源（protocol-utils.py 的 JS 等价）
function extractJson(content) {
  const s = content.trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/s);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  const cb = s.match(/```(?:json)?\s*(\{.*?\})\s*```/s);
  if (cb) { try { return JSON.parse(cb[1]); } catch {} }
  return null;
}

const done = new Set();
if (existsSync(outPath)) {
  for (const l of (await readFile(outPath, "utf-8")).split("\n").filter(Boolean)) {
    try { const r = JSON.parse(l); if (r.key != null) done.add(r.key); } catch {}
  }
}

const VALID = new Set(["observation", "inferred", "subjective"]);
let fixed = 0;
for (let idx = 0; idx < records.length; idx++) {
  if (done.has(String(idx))) continue;
  const rec = records[idx];
  const t0 = Date.now();
  const j = extractJson((await chat(system, JSON.stringify({ memories: rec.memories }), MAXTOK)).content);
  let labels = Array.isArray(j?.labels) ? j.labels : null;
  if (!labels || labels.length !== rec.memories.length || !labels.every((x) => VALID.has(x))) {
    // 标注是 E2 的输入而非结论：坏行重试一次，仍坏就落 null 状态（下游跳过该 record
    // 并报错清单），绝不让坏标签静默混进臂构造。
    const retry = extractJson((await chat(system, JSON.stringify({ memories: rec.memories }), MAXTOK)).content);
    const labels2 = Array.isArray(retry?.labels) ? retry.labels : null;
    if (!labels2 || labels2.length !== rec.memories.length || !labels2.every((x) => VALID.has(x))) {
      console.error(`[L ${idx + 1}/${records.length}] BAD LABELS，重试无效，跳过（记 null）`);
      await appendFile(outPath, JSON.stringify({ key: String(idx), idx, statuses: null }) + "\n");
      continue;
    }
    labels = labels2;
    fixed++;
  }
  await appendFile(outPath, JSON.stringify({ key: String(idx), idx, statuses: labels }) + "\n");
  console.error(`[L ${idx + 1}/${records.length}] ${((Date.now() - t0) / 1000).toFixed(1)}s ${labels.filter((x) => x === "observation").length}obs/${labels.filter((x) => x === "inferred").length}inf/${labels.filter((x) => x === "subjective").length}subj`);
}
console.error(`done，重试修复 ${fixed} 条；分布自查：node -e 统计 ${outPath}`);
