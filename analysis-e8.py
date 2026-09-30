#!/usr/bin/env python3
r"""E8 压缩悬崖保真归因分析。

输入:
  data/cliff_sessions.jsonl    造会话(40 = 5 场景 x 8 marker 变体, 160 约束)
  results-e8-mech.jsonl        各阶段机械 marker 命中(key=idx:stage, hits 布尔数组)
  results-e8-judge.jsonl       各阶段 judge 3-class(verdicts + counts)
  results-e8-gen.jsonl         LLM 原始输出(诊断:截断/空解析)

阶段: S1 蒸馏(真实 prompt+写入) | S2 巩固(真决策校验+应用) | S3 休眠降级(120 字符规则)
      R1/R2 重蒸馏悬崖曲线 | B 干预臂(prompt 加类型感知保真指令;闸门可跳过)

读数(plan 预注册):
  1) S1 保真率 = 主读数(>=90% 悬崖不成立 / <70% 悬崖重演);机械与 judge 双口径;
  2) 瀑布逐级增量损耗 S1→S2→S3;
  3) R 曲线衰减斜率 S1→R1→R2(对标论文『1 轮 53%、5 轮 10%』);
  4) 类型归位率:被保住约束的 entry_types 是否 constraint/preference(judge entry_types);
  5) B vs S1 的 Δ保真(论文 triage 主张检验;>10pp 有意义)。
"""
import json, sys
from collections import Counter, defaultdict

STAGES = ["S1", "S2", "S3", "R1", "R2", "B"]

def jload(p):
    try:
        return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
    except FileNotFoundError:
        sys.exit(f"missing {p} — 先从 out-v18 取回数据")

bench = {int(r["idx"]): r for r in jload("data/cliff_sessions.jsonl")}
mech = {(r["idx"], r["stage"]): r for r in jload("results-e8-mech.jsonl")}
jud = {(r["idx"], r["stage"]): r for r in jload("results-e8-judge.jsonl")}
gen = {(r["idx"], r["stage"]): r for r in jload("results-e8-gen.jsonl")}

n = len(bench)
total_constraints = sum(len(r["constraints"]) for r in bench.values())
print(f"覆盖: 会话 {n}, 约束 {total_constraints}; 各阶段行数:")
skipped_deadline = 0
for st in STAGES:
    m = sum(1 for (i, s) in mech if s == st)
    j = sum(1 for (i, s) in jud if s == st)
    g = sum(1 for (i, s) in gen if s == st)
    sk = sum(1 for (i, s) in mech if s == st and mech[(i, s)].get("skipped") == "deadline")
    if st in ("R2", "B") and sk:
        skipped_deadline += sk
    print(f"  {st}: mech {m} | judge {j} | gen {g}" + (f"  (deadline 跳过 {sk})" if sk else ""))

print("\n" + "=" * 78)
print("1) 各阶段保真率(主读数): 机械 marker 口径 + judge 3-class 口径")
print("=" * 78)
stage_stats = {}
for st in STAGES:
    mrows = [mech[(i, st)] for (i, s) in mech if s == st and not mech[(i, s)].get("skipped")]
    jrows = [jud[(i, st)] for (i, s) in jud if s == st]
    if not mrows and not jrows:
        continue
    hit_n = sum(sum(1 for h in r["hits"] if h) for r in mrows)
    hit_t = sum(len(r["hits"]) for r in mrows)
    f = sum(r["counts"]["faithful"] for r in jrows)
    d = sum(r["counts"]["distorted"] for r in jrows)
    dr = sum(r["counts"]["dropped"] for r in jrows)
    tot = f + d + dr
    stage_stats[st] = {
        "mech": hit_n / hit_t * 100 if hit_t else float("nan"),
        "faithful": f / tot * 100 if tot else float("nan"),
        "distorted": d / tot * 100 if tot else float("nan"),
        "dropped": dr / tot * 100 if tot else float("nan"),
        "judge_n": tot,
        "sess": len(jrows),
    }
    s = stage_stats[st]
    print(f"{st}: 机械 {s['mech']:.1f}%  |  judge faithful {s['faithful']:.1f}% / distorted {s['distorted']:.1f}% "
          f"/ dropped {s['dropped']:.1f}%  (会话 {s['sess']}, 约束 {s['judge_n']})")

print("\n" + "=" * 78)
print("2) 瀑布增量损耗(相对 S1 的 faithful 掉幅, judge 口径) + R 曲线")
print("=" * 78)
if "S1" in stage_stats:
    for st in ("S2", "S3", "R1", "R2", "B"):
        if st in stage_stats:
            print(f"  {st} vs S1: dFaithful={stage_stats[st]['faithful']-stage_stats['S1']['faithful']:+.1f}pp  "
                  f"d机械={stage_stats[st]['mech']-stage_stats['S1']['mech']:+.1f}pp")
curve = [st for st in ("S1", "R1", "R2") if st in stage_stats]
if len(curve) >= 2:
    print("  悬崖曲线 faithful: " + " → ".join(f"{st} {stage_stats[st]['faithful']:.1f}%" for st in curve))

print("\n" + "=" * 78)
print("3) 类型归位:被 faithful 保住的约束,表示它的 entry 是否 constraint/preference")
print("=" * 78)
for st in ("S1", "B"):
    typed = untyped = 0
    per_scen = defaultdict(lambda: [0, 0])
    for (i, s), r in jud.items():
        if s != st:
            continue
        for v in r["verdicts"]:
            if v.get("status") != "faithful":
                continue
            ets = v.get("entry_types") or []
            ok = any(t in ("constraint", "preference") for t in ets)
            typed += ok
            untyped += not ok
            scen = bench[i]["scenario"]
            per_scen[scen][0] += ok
            per_scen[scen][1] += not ok
    if typed + untyped:
        print(f"{st}: 类型归位 {typed}/{typed+untyped} = {typed/(typed+untyped)*100:.1f}%")
        for scen, (a, b) in sorted(per_scen.items()):
            print(f"    {scen}: {a}/({a}+{b})")

print("\n" + "=" * 78)
print("4) 诊断: 空解析/截断(gen 行 n_entries=0)与 S2 决策拒绝")
print("=" * 78)
empty = [(i, s) for (i, s), r in gen.items() if r.get("n_entries") == 0]
print(f"空解析: {empty or '无'}")
rej = [(i, r.get("ok")) for (i, s), r in mech.items() if s == "S2" and r.get("ok") is False]
print(f"S2 整单拒绝: {rej or '无'}")
applied = [r.get("applied", 0) for (i, s), r in mech.items() if s == "S2"]
if applied:
    print(f"S2 决策应用数: 均值 {sum(applied)/len(applied):.1f}, 分布 {dict(sorted(Counter(applied).items()))}")

print("\n" + "=" * 78)
print("5) 失败模式拆分: JSON 崩溃(静默窗口丢失) vs 纯压缩损耗")
print("=" * 78)
print("空解析 = 模型输出非法 JSON,真解析器拒收 -> 生产行为 = 窗口静默丢失(游标不推进)。")
print("raw 检查:模型其实输出了含约束的完整数组,只是中段语法错误(如 stray 引号)。")
for st in ("S1", "R1", "R2", "B"):
    rows = [r for (i, s), r in gen.items() if s == st]
    if not rows:
        continue
    crash = sum(1 for r in rows if r.get("n_entries") == 0)
    print(f"  {st}: JSON 崩溃 {crash}/{len(rows)} = {crash/len(rows)*100:.0f}%")
ok = lambda st: [i for (i, s) in gen if s == st and gen[(i, s)].get("n_entries", 0) > 0]
print("\n剔除崩溃后的纯压缩保真(faithful / 机械):")
pure = {}
for st in ("S1", "R1", "R2", "B"):
    ids = ok(st)
    f = sum(jud[(i, st)]["counts"]["faithful"] for i in ids if (i, st) in jud)
    d = sum(jud[(i, st)]["counts"]["distorted"] for i in ids if (i, st) in jud)
    dr = sum(jud[(i, st)]["counts"]["dropped"] for i in ids if (i, st) in jud)
    mh = sum(sum(1 for h in mech[(i, st)]["hits"] if h) for i in ids if (i, st) in mech)
    mt = sum(len(mech[(i, st)]["hits"]) for i in ids if (i, st) in mech)
    tt = f + d + dr
    if tt:
        pure[st] = f / tt * 100
        print(f"  {st} (n={len(ids)} 会话): {f}/{tt} = {f/tt*100:.1f}%  |  机械 {mh}/{mt} = {mh/mt*100:.1f}%" if mt else
              f"  {st} (n={len(ids)} 会话): {f}/{tt} = {f/tt*100:.1f}%")
if "S1" in pure:
    for st in ("R1", "R2", "B"):
        if st in pure:
            print(f"  {st} vs S1: {pure[st]-pure['S1']:+.1f}pp")
print("\nB 臂净效应 = 语义增益(崩溃外)− 崩溃代价(指令使输出更长更易碎):见上两行对照。")

print("\n" + "=" * 78)
print("6) S2 护栏交叉:被巩固丢掉的约束,其 S1 代表 entry 是否已归位类型")
print("=" * 78)
cross = defaultdict(int)
for (i, s), r in jud.items():
    if s != "S2":
        continue
    r1 = jud.get((i, "S1"))
    if not r1:
        continue
    s1_by_id = {v["id"]: v for v in r1["verdicts"]}
    for v2 in r["verdicts"]:
        v1 = s1_by_id.get(v2["id"])
        if not v1 or v1["status"] != "faithful" or v2["status"] == "faithful":
            continue
        ets = v1.get("entry_types") or []
        guarded = any(t in ("constraint", "preference") for t in ets)
        cross["typed(guarded)->lost" if guarded else "mis-typed->lost"] += 1
print(dict(cross), "  <- ARCHIVE_GUARDED_TYPES 只挡 archive 不挡 merge;误归类型是丢失大头")
