// PersistBench × dsh-mneme 向量切片：论文 §6.2 的忠实复现
//
// 用 dsh-mneme 自带 LocalEmbedder（Xenova/bge-small-zh-v1.5，本地 ONNX）+
// createVectorIndex，走 searchMemories 的 vector 路径。阈值打在 **纯余弦**
// 上（signalTransparency 开关给出的 signals.vector），与论文的 embedding
// 阈值同口径——融合分含 keyword/bm25 加成（0.6+0.4+0.3>1）不能用。
//
// 运行：node run-vector.mjs --mneme <dsh-mneme包路径> --cross-domain <jsonl> [--beneficial <jsonl>]
//        [--thresholds 0,0.3,0.5,0.6,0.7,0.75,0.8] [--topk 10] [--gate dom]
// 首跑会自动下载模型（~30MB，缓存到 ~/.dsh/mneme/models）。
//
// --gate dom（E9，#280 链 PersistBench 闭环）：在纯余弦臂（cos:<t>）之外加
// **oracle 域门控臂**（cos+dom:<t>）——门控 = 余弦阈值 ∧ 记忆域 == query 域，
// 域标签用数据自带的池级 memory_domain/query_domain（oracle 上界，不是真实
// 检测器）。回答的问题是：PersistBench 实测确认「zh embedder 打英文文本余弦
// 虚高、纯阈值无可用工作点」之后，域条件化取用作为替代杠杆的天花板有多高。
// beneficial 切片 query_domain=memory_domain="positives"，oracle 门恒真，
// cos+dom 臂与 cos 臂逐数相同——这是按构造的，只看 cross_domain 泄露侧。

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const mnemePath = flag("mneme") ?? process.env.MNEME_PKG;
const crossPath = flag("cross-domain");
const benPath = flag("beneficial");
if (!mnemePath || (!crossPath && !benPath)) {
  console.error("usage: node run-vector.mjs --mneme <dsh-mneme包路径> --cross-domain <jsonl> [--beneficial <jsonl>] [--thresholds ...] [--topk 10] [--gate dom]");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const { createStore } = require(`${mnemePath}/src/store.js`);
const { createService, computeRetrievalMetrics } = require(`${mnemePath}/src/service.js`);
const { createVectorIndex } = require(`${mnemePath}/src/vector-index.js`);
const { LocalEmbedder } = require(`${mnemePath}/src/local-embedder.js`);

const thresholds = (flag("thresholds") ?? "0,0.3,0.5,0.6,0.7,0.75,0.8").split(",").map(Number);
const topK = Number(flag("topk") ?? 10);
const gate = flag("gate"); // "dom" = 加 oracle 域门控臂

// 臂 = { label, minCos, domGate }；每条 record 只做一次检索，全部臂在同一次
// 候选集上切（顺带消除旧版「每阈值重种库重嵌入」的 N×M 浪费）。
const arms = thresholds.flatMap((t) => {
  const base = [{ label: `cos:${t}`, minCos: t, domGate: false }];
  return gate === "dom" ? [...base, { label: `cos+dom:${t}`, minCos: t, domGate: true }] : base;
});

console.error("init embedder (first run downloads model ~30MB)...");
const embedder = new LocalEmbedder({});
await embedder.init?.().catch?.(() => {});
const probe = await embedder.embedSingle("warmup");
console.error(`embedder ready, dim=${probe.length}`);

async function loadJsonl(path) {
  const text = await readFile(path, "utf-8");
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function evalSample(record, arms) {
  const store = createStore(":memory:");
  try {
    const service = createService({ store, mirror: null, config: { signalTransparency: true } });
    service.setEmbedder(embedder);
    service.setVectorIndex(createVectorIndex({ store }));
    const idToDomain = new Map();
    const ids = [];
    for (let i = 0; i < record.memories.length; i++) {
      const saved = service.saveWithDedupe({
        type: "preference",
        title: `m#${i}`,
        content: record.memories[i],
        importance: 3
      });
      idToDomain.set(saved.memory.id, record.memory_domain);
      ids.push(saved.memory.id);
    }
    // 种一次库、建一次索引、检索一次，全部臂在同一次候选集上切。
    // 阈值打在纯余弦（signals.vector）上——与论文 §6.2 的 embedding 阈值同口径；
    // domGate 臂再∧「记忆域 == query 域」（oracle 域标签）。
    const results = await service.searchMemories(record.query, {
      mode: "vector",
      topK,
      threshold: 0,
      useRerank: false,
      recordRecall: false
    });
    const cosOf = (r) => (r.signals && typeof r.signals.vector === "number") ? r.signals.vector : (r.score ?? 0);
    const perArm = new Map();
    for (const arm of arms) {
      const kept = results.filter((r) => cosOf(r) >= arm.minCos
        && (!arm.domGate || idToDomain.get(r.id) === record.query_domain));
      const leaked = kept.filter((r) => idToDomain.get(r.id) !== record.query_domain);
      const useful = kept.filter((r) => idToDomain.get(r.id) === record.query_domain);
      perArm.set(arm.label, {
        leaked_count: leaked.length,
        useful_count: useful.length,
        metrics: computeRetrievalMetrics(kept.map((r) => r.id), ids),
        topScore: results.length ? cosOf(results[0]) : 0
      });
    }
    return perArm;
  } finally {
    store.close?.();
  }
}

async function runSplit(name, path) {
  const records = await loadJsonl(path);
  console.log(`# ${name} n=${records.length} topk=${topK} mode=vector gate=${gate ?? "none"}`);
  console.log(["arm", "leak_rate", "useful_rate", "avg_precision", "avg_recall", "avg_mrr", "avg_top_score"].join("\t"));
  const acc = new Map(arms.map((a) => [a.label, { leakSamples: 0, useSamples: 0, p: 0, r: 0, mrr: 0, top: 0 }]));
  for (const record of records) {
    const per = await evalSample(record, arms);
    for (const [label, out] of per) {
      const a = acc.get(label);
      if (out.leaked_count > 0) a.leakSamples++;
      if (out.useful_count > 0) a.useSamples++;
      a.p += out.metrics.precision;
      a.r += out.metrics.recall;
      a.mrr += out.metrics.mrr;
      a.top += out.topScore;
    }
  }
  const n = records.length;
  const pct = (x) => (100 * x / n).toFixed(1) + "%";
  const avg = (x) => (x / n).toFixed(4);
  for (const [label, a] of acc) {
    console.log([label, pct(a.leakSamples), pct(a.useSamples), avg(a.p), avg(a.r), avg(a.mrr), avg(a.top)].join("\t"));
  }
}

async function main() {
  if (crossPath) await runSplit("cross_domain", crossPath);
  if (benPath) await runSplit("beneficial_samples", benPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
