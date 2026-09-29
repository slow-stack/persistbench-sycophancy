#!/usr/bin/env python3
"""E5 归因分析:四臂效用考卷(U0 无注入 / U1 importance-only / U2 现行量级 λ=0.002,β=1 / U3 拟合 λ=1.371,β=0.263)。

输入:
  data/beneficial_samples.jsonl   池(query + memories 字符串化列表)
  results-e5-labels.jsonl         role 标注 sidecar(v16 重标注,0 null;idx -> labels 列表)
  results-e5-gen.jsonl            四臂 G 结果(arm/idx/key/memories=注入集/query/response)
  results-e5-judge.jsonl          全池感知效用 judge(arm/idx/key/utility 1-5/violated=违规约束文本列表)

读数:
  1) 各臂:效用均值、违规率(样本级 any-violation、逐约束 compliance)、约束注入率(机制核查);
  2) 配对对比(同 idx 跨臂):预注册判据 = U3 vs U1/U2 约束遵从差 >=5pp 且方向为负 -> 拟合参数禁入注入;
  3) 机制核查:预注册假说是「recency 权重把 2-6 周老约束挤出 top-5」——约束注入率 + U2/U3 注入集重合度直接验证。

匹配口径:inject 侧有内容截断,注入文本↔池文本用双向子串容错匹配;
judge 的 violated 文本允许改写,先精确后子串,对不上的单列(miss)不计入违规数。

噪声尺:同 prompt 异会话漂移 ~4pp、同会话重复 ~3.2-3.4pp —— <5pp 的率差只作方向参考。
"""
import json, ast
from collections import Counter

ARMS = ["U0", "U1", "U2", "U3"]
norm = lambda s: " ".join(str(s).split()).strip().lower()

def jload(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]

recs = jload("data/beneficial_samples.jsonl")
labels = {}
for r in jload("results-e5-labels.jsonl"):
    v = r["labels"]
    labels[str(r["idx"])] = ast.literal_eval(v) if isinstance(v, str) else v
gen = jload("results-e5-gen.jsonl")
jud = jload("results-e5-judge.jsonl")

# 逐样本:池文本 -> role 映射 + 子串匹配候选集
pool_role, cons_set = [], []
for i, rec in enumerate(recs):
    ms = rec["memories"]
    ms = ast.literal_eval(ms) if isinstance(ms, str) else ms
    L = labels.get(str(i)) or [None] * len(ms)
    m = {norm(t): role for t, role in zip(ms, L) if role}
    pool_role.append(m)
    cons_set.append([t for t, role in m.items() if role == "constraint"])

ncon = [len(c) for c in cons_set]
labeled = sum(1 for i in range(len(recs)) if labels.get(str(i)))
withcon = [i for i in range(len(recs)) if ncon[i] > 0]
print(f"样本覆盖: labels 齐全 {labeled}/100, 含约束样本 {len(withcon)}/100 (约束总数 {sum(ncon)})")

gby = {(r["arm"], int(r["idx"])): r for r in gen}
jby = {(r["arm"], int(r["idx"])): r for r in jud}

def violated_constraints(i, vlist):
    hit, miss = 0, 0
    for v in vlist or []:
        vn = norm(v)
        if vn in pool_role[i] and pool_role[i][vn] == "constraint":
            hit += 1
            continue
        if any(vn and (vn in t or t in vn) for t in cons_set[i]):
            hit += 1
        else:
            miss += 1
    return hit, miss

def injected_constraints(i, inj):
    return sum(1 for m in inj if _match_role(i, m, "constraint"))

def _match_role(i, text, role):
    t = norm(text)
    if pool_role[i].get(t) == role:
        return True
    cands = [x for x, r in pool_role[i].items() if r == role]
    return any(t and (t in c or c in t) for c in cands)

per = {a: {} for a in ARMS}
for a in ARMS:
    for i in range(len(recs)):
        j = jby[(a, i)]
        inj = gby[(a, i)].get("memories") or []
        hit, miss = violated_constraints(i, j.get("violated"))
        per[a][i] = {
            "util": j["utility"],
            "nviol": hit, "viol_miss": miss, "raw_viol": len(j.get("violated") or []),
            "cinj": sum(1 for m in inj if _match_role(i, m, "constraint")),
            "finj": sum(1 for m in inj if _match_role(i, m, "filler")),
            "ncon": ncon[i], "inj": len(inj),
        }

print()
print("=" * 72)
print("1) 各臂聚合 (含约束样本 n=%d)" % len(withcon))
print("=" * 72)
for a in ARMS:
    d = per[a]
    wc = [d[i] for i in withcon]
    util_m = sum(r["util"] for r in d.values()) / len(recs)
    anyv = sum(1 if r["nviol"] > 0 else 0 for r in wc) / len(wc)
    compl = sum(1 - r["nviol"] / r["ncon"] for r in wc) / len(wc)
    raw_anyv = sum(1 if r["raw_viol"] > 0 else 0 for r in wc) / len(wc)
    cinj_rate = sum(r["cinj"] / r["ncon"] for r in wc) / len(wc)
    allin = sum(1 if r["cinj"] >= r["ncon"] else 0 for r in wc) / len(wc)
    finj = sum(r["finj"] for r in d.values()) / len(recs)
    miss = sum(r["viol_miss"] for r in d.values())
    print(f"{a}: utility={util_m:.2f}  违规率={anyv*100:.1f}%  逐约束遵从={compl*100:.1f}%  "
          f"[raw 口径={raw_anyv*100:.1f}%]")
    print(f"    约束注入率={cinj_rate*100:.1f}%  全注入率={allin*100:.1f}%  "
          f"平均注入 filler={finj:.2f}  judge违规未匹配数={miss}")

print()
print("=" * 72)
print("2) 配对对比 (同 idx 跨臂;率差过噪声尺 ~3-5pp 才可信)")
print("=" * 72)
def paired(a, b):
    d_util, d_compl = [], []
    wins = losses = ties = 0
    for i in withcon:
        ra, rb = per[a][i], per[b][i]
        d_util.append(rb["util"] - ra["util"])
        d_compl.append((1 - rb["nviol"] / rb["ncon"]) - (1 - ra["nviol"] / ra["ncon"]))
        if rb["nviol"] < ra["nviol"]: wins += 1
        elif rb["nviol"] > ra["nviol"]: losses += 1
        else: ties += 1
    av_a = sum(1 if per[a][i]["nviol"] > 0 else 0 for i in withcon) / len(withcon)
    av_b = sum(1 if per[b][i]["nviol"] > 0 else 0 for i in withcon) / len(withcon)
    n = len(withcon)
    mu = sum(d_util) / n
    mc = sum(d_compl) / n * 100
    return mu, mc, (av_b - av_a) * 100, wins, losses, ties

for a, b, tag in [("U0","U1","注入价值(importance-only)"), ("U0","U2","注入价值(现行量级)"),
                  ("U0","U3","注入价值(拟合参数)"), ("U1","U2","现行量级 vs importance-only"),
                  ("U1","U3","预注册判据: 拟合参数 vs importance-only"),
                  ("U2","U3","拟合参数 vs 现行量级")]:
    du, dc, dav, w, l, t = paired(a, b)
    print(f"{b} - {a} [{tag}]: dUtility={du:+.2f}  d遵从={dc:+.1f}pp  d违规率={dav:+.1f}pp  "
          f"违规方向(更少:更多:平)={w}:{l}:{t}")

print()
print("=" * 72)
print("3) 机制核查")
print("=" * 72)
same = 0
for i in range(len(recs)):
    i2 = set(norm(m) for m in (gby[("U2", i)].get("memories") or []))
    i3 = set(norm(m) for m in (gby[("U3", i)].get("memories") or []))
    if i2 == i3: same += 1
print(f"U3 注入集与 U2 逐样本完全相同: {same}/{len(recs)} (排序等价性:两参数档在这批回填年龄下无差别)")
for a in ("U1", "U2", "U3"):
    starved = [i for i in withcon if per[a][i]["cinj"] < per[a][i]["ncon"]]
    drop = Counter(per[a][i]["ncon"] - per[a][i]["cinj"] for i in starved)
    print(f"{a} 约束未全注入: {len(starved)}/{len(withcon)}  被挤掉数分布: {dict(sorted(drop.items()))}")
