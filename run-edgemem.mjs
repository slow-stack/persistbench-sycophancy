// E10 EdgeMem 考卷:零 LLM 原样写入(Z0) vs 蒸馏(Z1) vs 蒸馏+叙述条(Z2)——
// 「提前压缩丢细节」的三臂 QA(plan 2026-10-02)。
// 真代码路径:STR.prompts.summary / STR.prompts.narrative 原文 + parseSummaryJson +
// saveWithDedupe 真写入。宿主路由不可用 → LLM 直连 Ollama(诚实局限,落档注明)。
// 机械口径:marker 数字边界(store 存活率 + 答案命中);judge 口径:0-2 分批量判整会话。
// Z0 原样条目全部 importance 3(type decision/history)——原样写入不做重要度预判,
// 「不知道未来查询」正是 EdgeMem 式写入的含义。
//
// 用法: node run-edgemem.mjs --mneme <dsh-mneme包路径> --sessions data/edgemem_sessions.jsonl
//        --limit 30 --out results-e10 --gentok 250 --judgetok 700 --distilltok 1400
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
const sessionsPath = flag("sessions") ?? "data/edgemem_sessions.jsonl";
const limit = Number(flag("limit") ?? 30);
const outPrefix = flag("out") ?? "results-e10";
const genPath = `${outPrefix}-gen.jsonl`;
const judgePath = `${outPrefix}-judge.jsonl`;
const mechPath = `${outPrefix}-mech.jsonl`;
const genTokens = Number(flag("gentok") ?? 250);
const judgeTokens = Number(flag("judgetok") ?? 700);
const distillTokens = Number(flag("distilltok") ?? 1400);
const deadline = Number(flag("deadline-epoch") ?? 0);
const OLLAMA = flag("ollama") ?? "http://127.0.0.1:11434";
const MODEL = flag("model") ?? "qwen3:8b";
const dryRun = args.includes("--dry-run");
const MAX_ITEMS = 5;

if (!mnemePath) {
  console.error("usage: node run-edgemem.mjs --mneme <dsh-mneme包路径> [--sessions ...] ...");
  process.exit(1);
}

const req = createRequire(process.cwd() + "/");
const { createStore } = req(`${mnemePath}/src/store.js`);
const { createService } = req(`${mnemePath}/src/service.js`);
const { STR } = req(`${mnemePath}/src/lang.js`);
const { parseSummaryJson } = req(`${mnemePath}/src/summarize.js`);

const SUMMARY_PROMPT = STR.prompts.summary.en;
const NARRATIVE_PROMPT = STR.prompts.narrative.en;
const qaSystem = await readFile("protocol-qa-generator.txt", "utf-8");
const judgeSystem = await readFile("protocol-qa-judge.txt", "utf-8");

function loadJsonl(path) {
  return readFile(path, "utf-8").then((text) => text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l)) : []);
}

// 5xx/网络瞬断重试(v21 现场:ollama 500 在 ~375 次调用处偶发,无重试直接崩)。
async function chat(system, user, maxTokens) {
  const backoff = [5000, 15000, 30000];
  for (let a = 1; ; a++) {
    try {
      return await chatOnce(system, user, maxTokens);
    } catch (e) {
      const msg = String(e?.message ?? e);
      const retryable = /ollama 5\d\d|ollama 429|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(msg);
      if (!retryable || a > backoff.length) throw e;
      const wait = backoff[a - 1];
      console.error(`[retry ${a}] ${msg.slice(0, 90)} — ${wait / 1000}s 后重试`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function chatOnce(system, user, maxTokens) {
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

function markerHit(marker, text) {
  if (!marker) return null;
  const re = new RegExp("(?<![0-9])" + marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![0-9])");
  return re.test(text);
}

function remainingSec() {
  return deadline ? deadline - Date.now() / 1000 : Number.POSITIVE_INFINITY;
}

// store 存活率:桥接事实的 marker 是否出现在库内任何条目
function storeSurvival(session, store) {
  const contents = store.list().map((m) => m.content);
  return session.qa.map((q) => markerHit(q.marker, contents));
}

const records = (await loadJsonl(sessionsPath)).slice(0, limit);
console.error(`sessions=${records.length} deadline=${deadline ? new Date(deadline * 1000).toISOString() : "none"}`);

if (dryRun) {
  const rec = records[0];
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { hybridInject: false, bm25SearchEnabled: false } });
  for (const e of rec.raw_entries) {
    service.saveWithDedupe({ type: e.type, title: e.title, content: e.content, importance: 3 });
  }
  const rows = store.list();
  console.log("Z0 store:", rows.length, "| survival:", storeSurvival(rec, store).filter(Boolean).length + "/4");
  const inj = service.injectCandidates({ query: rec.qa[0].question, maxItems: MAX_ITEMS });
  console.log("inject:", inj.map((m) => m.title).join(" | "));
  store.close?.();
  process.exit(0);
}

const genDone = new Set((await loadJsonl(genPath).catch(() => [])).map((r) => r.key));
const judgeDone = new Set((await loadJsonl(judgePath).catch(() => [])).map((r) => r.key));
const mechDone = new Set((await loadJsonl(mechPath).catch(() => [])).map((r) => r.key));

async function mechWrite(idx, arm, session, store, extra = {}) {
  const key = `${idx}:${arm}`;
  if (mechDone.has(key)) return;
  const surv = storeSurvival(session, store);
  await appendFile(mechPath, JSON.stringify({ key, idx, arm, survival: surv, n_entries: store.list().length, ...extra }) + "\n");
  mechDone.add(key);
}

// 蒸馏/叙述构建,gen 行缓存(断点重放确定性)
async function buildEntries(idx, kind, system, user, sessionTag) {
  const key = `${idx}:${kind}`;
  if (!genDone.has(key)) {
    const r = await chat(system, user, distillTokens);
    const entries = kind === "distill" ? (parseSummaryJson(r.content) ?? []) : [];
    await appendFile(genPath, JSON.stringify({ key, idx, kind, raw: r.content, n_entries: entries.length }) + "\n");
    genDone.add(key);
  }
  const row = (await loadJsonl(genPath)).filter((r) => r.key === key).pop();
  return row;
}

const t00 = Date.now();
for (let idx = 0; idx < records.length; idx++) {
  const rec = records[idx];
  const t0 = Date.now();

  // ---- Z0:原样写入(零 LLM 构建)----
  {
    const store = createStore(":memory:");
    const service = createService({ store, mirror: null, config: { hybridInject: false, bm25SearchEnabled: false } });
    for (const e of rec.raw_entries) {
      service.saveWithDedupe({ type: e.type, title: e.title, content: e.content, importance: 3 });
    }
    await mechWrite(idx, "Z0", rec, store, { n_raw: rec.raw_entries.length });
    for (let qi = 0; qi < rec.qa.length; qi++) {
      const key = `${idx}:Z0:${qi}`;
      if (genDone.has(key)) continue;
      const q = rec.qa[qi];
      const inj = service.injectCandidates({ query: q.question, maxItems: MAX_ITEMS }).map((m) => m.content);
      const t1 = Date.now();
      const r = await chat(qaSystem, `Model Set Context:\n${inj.length ? inj.map((m) => `- ${m}`).join("\n") : "(none)"}\n\n${q.question}`, genTokens);
      await appendFile(genPath, JSON.stringify({
        key, idx, arm: "Z0", qi, question: q.question, memories: inj,
        injected_fact: inj.some((m) => markerHit(q.marker, m)), response: r.content,
      }) + "\n");
      genDone.add(key);
      console.error(`[G ${idx + 1}/30 Z0 q${qi}] ${((Date.now() - t1) / 1000).toFixed(0)}s inj_fact=${inj.some((m) => markerHit(q.marker, m))}`);
    }
    store.close?.();
  }

  // ---- Z1:蒸馏(真代码路径)----
  let z1Rows;
  {
    const store = createStore(":memory:");
    const service = createService({ store, mirror: null, config: {} });
    const build = await buildEntries(idx, "distill", SUMMARY_PROMPT, rec.transcript, `session:synth-${idx}`);
    const entries = parseSummaryJson(build.raw) ?? [];
    for (const e of entries) {
      service.saveWithDedupe({
        type: e.type, title: e.title, content: e.content,
        importance: Number.isFinite(e.importance) ? e.importance : 3, source: `session:synth-${idx}`,
      });
    }
    z1Rows = store.list();
    await mechWrite(idx, "Z1", rec, store, { n_entries: z1Rows.length });
    for (let qi = 0; qi < rec.qa.length; qi++) {
      const key = `${idx}:Z1:${qi}`;
      if (genDone.has(key)) continue;
      const q = rec.qa[qi];
      const inj = service.injectCandidates({ query: q.question, maxItems: MAX_ITEMS }).map((m) => m.content);
      const t1 = Date.now();
      const r = await chat(qaSystem, `Model Set Context:\n${inj.length ? inj.map((m) => `- ${m}`).join("\n") : "(none)"}\n\n${q.question}`, genTokens);
      await appendFile(genPath, JSON.stringify({
        key, idx, arm: "Z1", qi, question: q.question, memories: inj,
        injected_fact: inj.some((m) => markerHit(q.marker, m)), response: r.content,
      }) + "\n");
      genDone.add(key);
      console.error(`[G ${idx + 1}/30 Z1 q${qi}] ${((Date.now() - t1) / 1000).toFixed(0)}s inj_fact=${inj.some((m) => markerHit(q.marker, m))}`);
    }
    store.close?.();
  }

  // ---- Z2:蒸馏 + 叙述条(STR.prompts.narrative,type=summary/source=dream)----
  {
    const store = createStore(":memory:");
    const service = createService({ store, mirror: null, config: {} });
    const build = await buildEntries(idx, "distill", SUMMARY_PROMPT, rec.transcript, `session:synth-${idx}`);
    const entries = parseSummaryJson(build.raw) ?? [];
    for (const e of entries) {
      service.saveWithDedupe({
        type: e.type, title: e.title, content: e.content,
        importance: Number.isFinite(e.importance) ? e.importance : 3, source: `session:synth-${idx}`,
      });
    }
    const rows = store.list();
    const nKey = `${idx}:narrative`;
    if (!genDone.has(nKey)) {
      const listText = rows.map((m) => `id=${m.id} | type=${m.type} | importance=${m.importance} | title=${m.title} | content=${m.content}`).join("\n");
      const r = await chat(NARRATIVE_PROMPT, listText, distillTokens);
      await appendFile(genPath, JSON.stringify({ key: nKey, idx, kind: "narrative", raw: r.content, n_pool: rows.length }) + "\n");
      genDone.add(nKey);
    }
    const nRow = (await loadJsonl(genPath)).filter((r) => r.key === nKey).pop();
    const narrative = nRow.raw.trim();
    if (narrative) {
      service.saveWithDedupe({ type: "summary", title: "Session narrative", content: narrative, importance: 5, source: "dream" });
    }
    await mechWrite(idx, "Z2", rec, store, { n_entries: store.list().length, narrative: Boolean(narrative) });
    for (let qi = 0; qi < rec.qa.length; qi++) {
      const key = `${idx}:Z2:${qi}`;
      if (genDone.has(key)) continue;
      const q = rec.qa[qi];
      const inj = service.injectCandidates({ query: q.question, maxItems: MAX_ITEMS }).map((m) => m.content);
      const t1 = Date.now();
      const r = await chat(qaSystem, `Model Set Context:\n${inj.length ? inj.map((m) => `- ${m}`).join("\n") : "(none)"}\n\n${q.question}`, genTokens);
      await appendFile(genPath, JSON.stringify({
        key, idx, arm: "Z2", qi, question: q.question, memories: inj,
        injected_fact: inj.some((m) => markerHit(q.marker, m)), response: r.content,
      }) + "\n");
      genDone.add(key);
      console.error(`[G ${idx + 1}/30 Z2 q${qi}] ${((Date.now() - t1) / 1000).toFixed(0)}s inj_fact=${inj.some((m) => markerHit(q.marker, m))}`);
    }
    store.close?.();
  }

  // ---- J:批量判整会话(每臂 1 次)----
  const genRows = await loadJsonl(genPath);
  for (const arm of ["Z0", "Z1", "Z2"]) {
    const key = `${idx}:${arm}`;
    if (judgeDone.has(key)) continue;
    const qas = [];
    let missing = 0;
    for (let qi = 0; qi < rec.qa.length; qi++) {
      const g = genRows.filter((r) => r.key === `${idx}:${arm}:${qi}`).pop();
      if (!g) { missing++; continue; }
      qas.push({ question: g.question, answer: g.response, ground_truth: rec.qa[qi].ground_truth, marker: rec.qa[qi].marker });
    }
    if (missing) { console.error(`[J] ${key} 缺 ${missing} 条 G 行,跳过`); continue; }
    if (remainingSec() < 15 * 60) { console.error(`[gate] ${key} 跳过(余 ${Math.floor(remainingSec() / 60)}min)`); break; }
    const t1 = Date.now();
    const payload = { qas: qas.map((q, i) => ({ index: i, question: q.question, answer: q.answer, ground_truth: q.ground_truth, marker: q.marker })) };
    const resp = await chat(judgeSystem, JSON.stringify(payload), judgeTokens);
    let verdicts = null;
    try { verdicts = JSON.parse(resp.content.trim()); } catch {
      const m = resp.content.match(/\{[\s\S]*\}/);
      if (m) { try { verdicts = JSON.parse(m[0]); } catch {} }
    }
    const vs = Array.isArray(verdicts?.verdicts) ? verdicts.verdicts : [];
    await appendFile(judgePath, JSON.stringify({
      key, idx, arm, verdicts: vs,
      counts: { full: vs.filter((v) => v.score === 2).length, partial: vs.filter((v) => v.score === 1).length, zero: vs.filter((v) => v.score === 0).length },
    }) + "\n");
    judgeDone.add(key);
    console.error(`[J ${arm}] idx=${idx} 2/1/0=${vs.filter((v) => v.score === 2).length}/${vs.filter((v) => v.score === 1).length}/${vs.filter((v) => v.score === 0).length} ${((Date.now() - t1) / 1000).toFixed(0)}s`);
  }

  console.error(`[sess ${idx + 1}/${records.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

console.log(`limit=${limit} gentok=${genTokens} judgetok=${judgeTokens} distilltok=${distillTokens}`);
