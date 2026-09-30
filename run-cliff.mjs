// E8 压缩悬崖保真:四级瀑布(S1 蒸馏 → S2 巩固 → S3 休眠降级)+ 重蒸馏悬崖曲线(R1/R2)
// + 干预臂 B(prompt 加保真指令,配额闸门最后砍)。
// 真代码路径:STR.prompts.summary(lang.js)+ parseSummaryJson(summarize.js)+
// saveWithDedupe(quality filter 开)+ validateDecisions/applyDecisions(decisions.js,默认档)。
// 宿主路由不可用 → LLM 调用直连 Ollama,prompt 逐字取自源码(诚实局限,落档注明)。
// 机械口径:marker 数字边界命中(gen-cliff-sessions.py 同尺);judge 口径:3-class 保真。
// 墙钟闸门:--deadline-epoch 之前 25 分钟才启动 R2/B;跳过写进 mech 行。
//
// 用法: node run-cliff.mjs --mneme <dsh-mneme包路径> --sessions cliff_sessions.jsonl --limit 40
//        --out results-e8 --deadline-epoch 1234567890
// 断点续跑:append + seen-set。

import { readFile, appendFile } from "node:fs/promises";
import { createRequire } from "node:module";
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mnemePath = flag("mneme") ?? process.env.MNEME_PKG;
const sessionsPath = flag("sessions") ?? "data/cliff_sessions.jsonl";
const limit = Number(flag("limit") ?? 40);
const outPrefix = flag("out") ?? "results-e8";
const genPath = `${outPrefix}-gen.jsonl`;
const judgePath = `${outPrefix}-judge.jsonl`;
const mechPath = `${outPrefix}-mech.jsonl`;
const distillTokens = Number(flag("distilltok") ?? 1400);
const judgeTokens = Number(flag("judgetok") ?? 700);
const deadline = Number(flag("deadline-epoch") ?? 0); // epoch 秒;0 = 无闸门
const OLLAMA = flag("ollama") ?? "http://127.0.0.1:11434";
const MODEL = flag("model") ?? "qwen3:8b";
const dryRun = args.includes("--dry-run");

if (!mnemePath) {
  console.error("usage: node run-cliff.mjs --mneme <dsh-mneme包路径> [--sessions cliff_sessions.jsonl] ...");
  process.exit(1);
}

const req = createRequire(process.cwd() + "/");
const { createStore } = req(`${mnemePath}/src/store.js`);
const { createService } = req(`${mnemePath}/src/service.js`);
const { STR } = req(`${mnemePath}/src/lang.js`);
const { parseSummaryJson } = req(`${mnemePath}/src/summarize.js`);
const { validateDecisions, applyDecisions } = req(`${mnemePath}/src/dream/decisions.js`);

const SUMMARY_PROMPT = STR.prompts.summary.en;
const CONSOLIDATION_PROMPT = STR.prompts.consolidation.en;
// 干预臂 B(论文 Knowledge Triage 的最小变体):类型感知保真指令
const FIDELITY_SUFFIX = "\n\n[Fidelity rule] Entries of type \"constraint\" or \"preference\" must be copied into the output with their full original wording — never paraphrase, generalize, or merge away their specific values.";

const judgeSystem = await readFile("protocol-fidelity-judge.txt", "utf-8");

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

// sleep.js makeSummary 逐字复刻(SUMMARY_MAX=120,截断加 …)
const SUMMARY_MAX = 120;
function demote(text) {
  const t = (text ?? "").trim();
  if (!t) return t;
  return t.length <= SUMMARY_MAX ? t : `${t.slice(0, SUMMARY_MAX)}…`;
}

// marker 数字边界命中(与 gen-cliff-sessions.py 同尺)
function markerHit(marker, texts) {
  if (!marker) return null;
  const re = new RegExp("(?<![0-9])" + marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![0-9])");
  return texts.some((t) => re.test(t));
}

function extractArray(content) {
  const s = content.trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
function extractJson(content) {
  const s = content.trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

function remainingSec() {
  return deadline ? deadline - Date.now() / 1000 : Number.POSITIVE_INFINITY;
}

// 机械计量:逐约束 marker 是否在文本集中;同时返回命中文本
function mechCheck(constraints, texts) {
  return constraints.map((c) => ({
    marker: c.marker,
    hit: c.marker ? markerHit(c.marker, texts) : null,
  }));
}

// 把 entries 渲染成「可再蒸馏」的文本(R 轮输入)
function renderEntries(entries) {
  return entries.map((e) => `- [${e.type}] ${e.title}: ${e.content}`).join("\n");
}

// 真实写入路径:saveWithDedupe(quality filter 默认开)
function saveEntries(service, entries, sessionTag) {
  const saved = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const r = service.saveWithDedupe({
      type: e.type, title: e.title ?? `entry#${i}`, content: e.content,
      importance: Number.isFinite(e.importance) ? e.importance : 3,
      source: sessionTag,
    });
    saved.push(r.memory);
  }
  return saved;
}

function listRows(store) {
  // store.list 默认全量;只取未归档(dream 快照口径)
  return store.list().filter((m) => !m.archived);
}

async function fidelityJudge(idx, stage, constraints, entries, judgeDone) {
  const key = `${idx}:${stage}`;
  if (judgeDone.has(key)) return null;
  const payload = {
    constraints: constraints.map((c, i) => ({ id: `c${i}`, text: c.text, marker: c.marker })),
    entries: entries.map((e) => ({ type: e.type, title: e.title, content: e.content })),
  };
  const t0 = Date.now();
  const j = extractJson((await chat(judgeSystem, JSON.stringify(payload), judgeTokens)).content);
  const verdicts = Array.isArray(j?.verdicts) ? j.verdicts : [];
  await appendFile(judgePath, JSON.stringify({
    key, idx, stage,
    verdicts,
    counts: {
      faithful: verdicts.filter((v) => v.status === "faithful").length,
      distorted: verdicts.filter((v) => v.status === "distorted").length,
      dropped: verdicts.filter((v) => v.status === "dropped").length,
    },
  }) + "\n");
  console.error(`[J ${stage}] idx=${idx} f/d/d=${verdicts.filter((v) => v.status === "faithful").length}/${verdicts.filter((v) => v.status === "distorted").length}/${verdicts.filter((v) => v.status === "dropped").length} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return j;
}

const records = (await loadJsonl(sessionsPath)).slice(0, limit);
console.error(`sessions=${records.length} deadline=${deadline ? new Date(deadline * 1000).toISOString() : "none"}`);

if (dryRun) {
  // 干跑:只验证机械链路(种库/写路径/快照渲染),不调 LLM
  const rec = records[0];
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const fake = rec.constraints.map((c, i) => ({ type: c.type_hint, title: `c${i}`, content: c.text, importance: 4 }));
  const saved = saveEntries(service, fake, "session:dry");
  console.log("saved:", saved.length, "| archived:", saved.filter((m) => m.archived).length);
  const rows = listRows(store);
  console.log("listRows:", rows.length);
  const listText = rows.map((m) => `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`).join("\n");
  console.log("listText head:", listText.slice(0, 120));
  const v = validateDecisions([{ action: "keep", ids: [rows[0].id] }], new Map(rows.map((m) => [m.id, m])), { skipInvalid: true, allowedActions: ["keep", "merge", "archive", "conflict", "update", "create"] });
  console.log("validate keep:", v.ok, v.errors ?? "");
  console.log("mech:", JSON.stringify(mechCheck(rec.constraints, rows.map((m) => m.content))));
  console.log("demote:", demote("x".repeat(130)).length);
  store.close?.();
  process.exit(0);
}

const genDone = new Set((await loadJsonl(genPath).catch(() => [])).map((r) => r.key));
const judgeDone = new Set((await loadJsonl(judgePath).catch(() => [])).map((r) => r.key));
const mechDone = new Set((await loadJsonl(mechPath).catch(() => [])).map((r) => r.key));

async function mechWrite(idx, stage, constraints, texts, extra = {}) {
  const key = `${idx}:${stage}`;
  if (mechDone.has(key)) return;
  const checks = mechCheck(constraints, texts);
  await appendFile(mechPath, JSON.stringify({ key, idx, stage, hits: checks.map((c) => c.hit), n_texts: texts.length, ...extra }) + "\n");
  mechDone.add(key);
}

async function distillIntoStore(system, transcript, sessionTag) {
  const r = await chat(system, transcript, distillTokens);
  const entries = parseSummaryJson(r.content) ?? [];
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const saved = saveEntries(service, entries, sessionTag);
  return { raw: r.content, saved, store, service, nEntries: entries.length };
}

for (let idx = 0; idx < records.length; idx++) {
  const rec = records[idx];
  const t0 = Date.now();
  let postS2Rows = [];

  // ---- S1 蒸馏(真实 prompt + 真实写入路径)----
  const s1Store = createStore(":memory:");
  {
    const key = `${idx}:S1`;
    if (!genDone.has(key)) {
      const r = await chat(SUMMARY_PROMPT, rec.transcript, distillTokens);
      const entries = parseSummaryJson(r.content) ?? [];
      await appendFile(genPath, JSON.stringify({ key, idx, stage: "S1", raw: r.content, n_entries: entries.length }) + "\n");
      genDone.add(key);
    }
    // 从 gen 行重建保存(断点安全:重放 parse+save,确定性)
    const genRow = (await loadJsonl(genPath)).filter((r) => r.key === key).pop();
    const entries = parseSummaryJson(genRow.raw) ?? [];
    const service = createService({ store: s1Store, mirror: null, config: {} });
    saveEntries(service, entries, `session:synth-${idx}`);
    const s1Rows = listRows(s1Store);
    await mechWrite(idx, "S1", rec.constraints, s1Rows.map((m) => m.content), { n_entries: s1Rows.length });
  }
  {
    const s1Rows = listRows(s1Store);
    await fidelityJudge(idx, "S1", rec.constraints, s1Rows, judgeDone);
  }

  // ---- S2 巩固(真决策 prompt + 真校验/应用)----
  {
    const key = `${idx}:S2`;
    const service = createService({ store: s1Store, mirror: null, config: {} });
    // 诱饵入库(resume 幂等:按 title 去重,saveWithDedupe 的同题合并会让内容翻倍)
    const have = new Set(listRows(s1Store).map((m) => m.title));
    const newDecoys = rec.decoys.filter((d) => !have.has(d.title));
    saveEntries(service, newDecoys, `decoy:synth-${idx}`);
    if (!genDone.has(key)) {
      const rows = listRows(s1Store);
      const listText = rows.map((m) => `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`).join("\n");
      const r = await chat(CONSOLIDATION_PROMPT, listText, distillTokens);
      await appendFile(genPath, JSON.stringify({ key, idx, stage: "S2", raw: r.content, n_pool: rows.length }) + "\n");
      genDone.add(key);
    }
    const genRow = (await loadJsonl(genPath)).filter((r) => r.key === key).pop();
    const decisions = extractArray(genRow.raw) ?? [];
    const rows = listRows(s1Store);
    const snapshot = new Map(rows.map((m) => [m.id, m]));
    const { ok, errors, skipped } = validateDecisions(decisions, snapshot, {
      skipInvalid: true,
      allowedActions: ["keep", "merge", "archive", "conflict", "update", "create"],
      minAgeHours: 24,
    });
    let applied = 0;
    if (ok) {
      const res = applyDecisions(decisions, service, null, snapshot, {});
      applied = res?.committed?.length ?? res?.applied?.length ?? 0;
    } else {
      console.error(`[S2] idx=${idx} 决策整单拒绝: ${errors?.[0] ?? "?"}`);
    }
    postS2Rows = listRows(s1Store);
    await mechWrite(idx, "S2", rec.constraints, postS2Rows.map((m) => m.content), {
      n_entries: postS2Rows.length, decisions: decisions.length, ok, applied, skipped: skipped?.length ?? 0,
    });
    await fidelityJudge(idx, "S2", rec.constraints, postS2Rows, judgeDone);
  }

  // ---- S3 休眠降级(机械,零 LLM)----
  await mechWrite(idx, "S3", rec.constraints, postS2Rows.map((m) => demote(m.content)), { n_entries: postS2Rows.length });


  // ---- R1 重蒸馏(post-S2 条目渲染回文本,再走一遍蒸馏)----
  if (!genDone.has(`${idx}:R1`)) {
    const r = await chat(SUMMARY_PROMPT, renderEntries(postS2Rows), distillTokens);
    const entries = parseSummaryJson(r.content) ?? [];
    await appendFile(genPath, JSON.stringify({ key: `${idx}:R1`, idx, stage: "R1", raw: r.content, n_entries: entries.length }) + "\n");
    genDone.add(`${idx}:R1`);
  }
  {
    const genRow = (await loadJsonl(genPath)).filter((r) => r.key === `${idx}:R1`).pop();
    const entries = parseSummaryJson(genRow.raw) ?? [];
    const r1Store = createStore(":memory:");
    const r1Service = createService({ store: r1Store, mirror: null, config: {} });
    const saved = saveEntries(r1Service, entries, `redistill:${idx}:1`);
    const r1Rows = listRows(r1Store);
    await mechWrite(idx, "R1", rec.constraints, r1Rows.map((m) => m.content), { n_entries: r1Rows.length });
    await fidelityJudge(idx, "R1", rec.constraints, r1Rows, judgeDone);
    r1Store.close?.();

    // ---- R2 重蒸馏(闸门)----
    if (remainingSec() > 25 * 60) {
      if (!genDone.has(`${idx}:R2`)) {
        const r = await chat(SUMMARY_PROMPT, renderEntries(r1Rows), distillTokens);
        const entries2 = parseSummaryJson(r.content) ?? [];
        await appendFile(genPath, JSON.stringify({ key: `${idx}:R2`, idx, stage: "R2", raw: r.content, n_entries: entries2.length }) + "\n");
        genDone.add(`${idx}:R2`);
      }
      const genRow2 = (await loadJsonl(genPath)).filter((r) => r.key === `${idx}:R2`).pop();
      const entries2 = parseSummaryJson(genRow2.raw) ?? [];
      const r2Store = createStore(":memory:");
      const r2Service = createService({ store: r2Store, mirror: null, config: {} });
      const saved2 = saveEntries(r2Service, entries2, `redistill:${idx}:2`);
      const r2Rows = listRows(r2Store);
      await mechWrite(idx, "R2", rec.constraints, r2Rows.map((m) => m.content), { n_entries: r2Rows.length });
      await fidelityJudge(idx, "R2", rec.constraints, r2Rows, judgeDone);
      r2Store.close?.();
    } else {
      await mechWrite(idx, "R2", [], [], { skipped: "deadline" });
      console.error(`[gate] idx=${idx} R2 跳过(余 ${Math.floor(remainingSec() / 60)}min)`);
    }
  }

  // ---- 干预臂 B(保真指令变体;闸门最后砍)----
  if (remainingSec() > 25 * 60) {
    if (!genDone.has(`${idx}:B`)) {
      const r = await chat(SUMMARY_PROMPT + FIDELITY_SUFFIX, rec.transcript, distillTokens);
      const entries = parseSummaryJson(r.content) ?? [];
      await appendFile(genPath, JSON.stringify({ key: `${idx}:B`, idx, stage: "B", raw: r.content, n_entries: entries.length }) + "\n");
      genDone.add(`${idx}:B`);
    }
    const genRow = (await loadJsonl(genPath)).filter((r) => r.key === `${idx}:B`).pop();
    const entries = parseSummaryJson(genRow.raw) ?? [];
    const bStore = createStore(":memory:");
    const bService = createService({ store: bStore, mirror: null, config: {} });
    saveEntries(bService, entries, `armB:${idx}`);
    const bRows = listRows(bStore);
    await mechWrite(idx, "B", rec.constraints, bRows.map((m) => m.content), { n_entries: bRows.length });
    await fidelityJudge(idx, "B", rec.constraints, bRows, judgeDone);
    bStore.close?.();
  } else {
    await mechWrite(idx, "B", [], [], { skipped: "deadline" });
  }

  s1Store.close?.();
  console.error(`[sess ${idx + 1}/${records.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

console.log(`limit=${limit} distilltok=${distillTokens} judgetok=${judgeTokens}`);
