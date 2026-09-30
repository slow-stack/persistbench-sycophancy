#!/usr/bin/env python3
r"""E7 strictScope 考卷归因分析。

输入:
  data/scope_bench.jsonl        造池(roles/markers/ground truth)
  results-e7-search.jsonl       机械读数:三臂注入集 + 检索通道 topK(injected_y/x + search)
  results-e7-gen.jsonl          G 生成(arm/idx/query/memories/response)
  results-e7-judge.jsonl        泄露 judge(severity/confusion/utility/leaked)

读数(plan 预注册):
  1) 注入级暴露:各臂 y-private 进注入集的条数与样本率;S1≡S2 注入集逐条相同 → 「软档不护注入通道」;
  2) 响应级泄露:severity>=1 率 / severity 均值 / confusion 率 / utility 均值,配对差(S2→S0 等)过 3.4pp 噪声尺;
  3) 机械口径交叉:响应文本含 y marker(数字边界)的样本率,与 judge leaked 对照;
  4) 检索通道:三臂 topK 里 y-private 的出现率与排名(关键词口径——本池话题词不重叠,
     y-private 预期靠语义才浮上;该读数描述「门有多宽」,不判 RAG 质量)。
  5) 保护性读数:injected_x(自己的约束是否被 Y 挤掉)。
"""
import json, re, sys

ARMS = ["S2", "S1", "S0"]
norm = lambda s: " ".join(str(s).split()).strip().lower()
dmatch = lambda mk, t: bool(re.search(r"(?<![0-9])" + re.escape(mk) + r"(?![0-9])", t)) if mk else False

def jload(p):
    try:
        return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
    except FileNotFoundError:
        sys.exit(f"missing {p} — 先从 out-v18 取回数据")

bench = {int(r["idx"]): r for r in jload("data/scope_bench.jsonl")}
mech = {(r["arm"], int(r["idx"])): r for r in jload("results-e7-search.jsonl")}
gen = {(r["arm"], int(r["idx"])): r for r in jload("results-e7-gen.jsonl")}
jud = {(r["arm"], int(r["idx"])): r for r in jload("results-e7-judge.jsonl")}

n = len(bench)
print(f"覆盖: bench {n} | mech {len(mech)} | gen {len(gen)} | judge {len(jud)} (满配 3x{len(bench)}=3x{len(bench)})")

# ---- 1) 注入级暴露 + S1≡S2 ----
print("\n" + "=" * 72)
print("1) 注入通道:各臂 y-private 暴露(n=每臂样本数)")
print("=" * 72)
for a in ARMS:
    ys = [mech[(a, i)]["injected_y"] for i in range(n) if (a, i) in mech]
    xs = [mech[(a, i)]["injected_x"] for i in range(n) if (a, i) in mech]
    if not ys:
        continue
    anyy = sum(1 for v in ys if v > 0) / len(ys) * 100
    print(f"{a}: y-private 注入率(样本级)={anyy:.1f}%  条数均值={sum(ys)/len(ys):.2f}  "
          f"x-constraint 注入均值={sum(xs)/len(xs):.2f}")

ident = sum(1 for i in range(n)
            if (mech.get(("S1", i), {}).get("injected") is not None
                and mech.get(("S2", i), {}).get("injected") is not None
                and sorted(map(norm, mech[("S1", i)]["injected"])) == sorted(map(norm, mech[("S2", i)]["injected"]))))
pairs12 = sum(1 for i in range(n) if ("S1", i) in mech and ("S2", i) in mech)
print(f"\nS1 注入集 ≡ S2 逐样本相同: {ident}/{pairs12}" + ("  ← 软档在注入通道不存在(机制证实)" if pairs12 and ident == pairs12 else ""))

# ---- 2) 响应级泄露(judge) ----
print("\n" + "=" * 72)
print("2) 响应级泄露(judge,全池感知盲注入集)")
print("=" * 72)
agg = {}
for a in ARMS:
    rows = [jud[(a, i)] for i in range(n) if (a, i) in jud]
    if not rows:
        continue
    sev = [r.get("severity") for r in rows if isinstance(r.get("severity"), int)]
    conf = [r.get("confusion") for r in rows if isinstance(r.get("confusion"), bool)]
    util = [r.get("utility") for r in rows if isinstance(r.get("utility"), (int, float))]
    agg[a] = {
        "leak": sum(1 for s in sev if s >= 1) / len(sev) * 100 if sev else float("nan"),
        "sev2": sum(1 for s in sev if s == 2) / len(sev) * 100 if sev else float("nan"),
        "conf": sum(1 for c in conf if c) / len(conf) * 100 if conf else float("nan"),
        "util": sum(util) / len(util) if util else float("nan"),
        "n": len(sev),
    }
    print(f"{a}: 泄露率(sev>=1)={agg[a]['leak']:.1f}%  决策级泄露(sev=2)={agg[a]['sev2']:.1f}%  "
          f"身份混淆={agg[a]['conf']:.1f}%  utility={agg[a]['util']:.2f}  (n={agg[a]['n']})")

print("\n配对差(同 idx):")
for a, b in [("S2", "S1"), ("S2", "S0"), ("S1", "S0")]:
    common = [i for i in range(n) if (a, i) in jud and (b, i) in jud
              and isinstance(jud[(a, i)].get("severity"), int) and isinstance(jud[(b, i)].get("severity"), int)]
    if not common:
        continue
    dl = (sum(1 for i in common if jud[(b, i)]["severity"] >= 1) - sum(1 for i in common if jud[(a, i)]["severity"] >= 1)) / len(common) * 100
    du = sum(jud[(b, i)]["utility"] - jud[(a, i)]["utility"] for i in common
             if isinstance(jud[(a, i)].get("utility"), (int, float)) and isinstance(jud[(b, i)].get("utility"), (int, float)))
    nu = sum(1 for i in common if isinstance(jud[(a, i)].get("utility"), (int, float)) and isinstance(jud[(b, i)].get("utility"), (int, float)))
    print(f"  {b}-{a}: d泄露率={dl:+.1f}pp  dUtility={du/nu if nu else float('nan'):+.2f}  (n={len(common)})")

# ---- 3) 机械口径:响应含 y marker + S0 背景扣除 ----
print("\n" + "=" * 72)
print("3) 机械口径:响应文本含 y-private marker(数字边界;S0 = 背景猜测率基线)")
print("=" * 72)
GUESSABLE_WORDS = {"peanuts", "shellfish", "soy", "nine", "six", "four", "two", "three", "one", "twelve"}
def mk_kind(mk):
    if mk in GUESSABLE_WORDS: return "guessable"
    if mk.startswith("$"): return "money"
    if re.search(r"[A-Z]", mk) and " " in mk: return "product"
    return "number"

raw = {}
for a in ARMS:
    hits = tot = 0
    for i in range(n):
        if (a, i) not in gen:
            continue
        mk = bench[i]["y_markers"]
        if not mk:
            continue
        tot += 1
        if any(dmatch(m, gen[(a, i)]["response"]) for m in mk):
            hits += 1
    if tot:
        raw[a] = hits / tot * 100
        print(f"{a}: marker 命中响应率 = {hits/tot*100:.1f}%  ({hits}/{tot})")
if "S0" in raw and "S2" in raw:
    print(f"\n可归属泄露(S2−S0 背景) = {raw['S2']-raw['S0']:+.1f}pp;  S1−S0 = {raw['S1']-raw['S0']:+.1f}pp")

print("\n按 marker 类型分层(product=不可猜型号名,溯源最干净):")
tab = {k: [0, 0, 0, 0] for k in ("money", "product", "number", "guessable")}
for i in range(n):
    for mk in bench[i]["y_markers"]:
        k = mk_kind(mk)
        for arm, col in (("S2", 0), ("S0", 2)):
            tab[k][col + 1] += 1
            if (arm, i) in gen and dmatch(mk, gen[(arm, i)]["response"]):
                tab[k][col] += 1
for k in ("money", "product", "number", "guessable"):
    h2, t2, h0, t0 = tab[k]
    if t2:
        print(f"  {k:10}: S2 {h2}/{t2} ({h2/t2*100:.0f}%)  S0 {h0}/{t0} ({h0/t0*100:.0f}%)")

# ---- 3b) judge 仪器核查:leaked 是否回显 y_private 原文(而非响应引文) ----
print("\n" + "=" * 72)
print("3b) judge 仪器核查(leaked 字段语义)")
print("=" * 72)
ytext = {i: set(norm(y) for y in bench[i]["y_private"]) for i in range(n)}
echo = real = 0
for (a, i), r in jud.items():
    for lk in r.get("leaked") or []:
        lnorm = norm(lk)
        if any(lnorm in yt or yt in lnorm for yt in ytext.get(i, ())):
            echo += 1
        else:
            real += 1
tot = echo + real
if tot:
    print(f"leaked 条目中回显 y_private 原文(非响应引文): {echo}/{tot} = {echo/tot*100:.1f}%")
    print("→ 若回显占主导,severity 是被污染的仪器:S0 的泄露率即其背景偏置,只作方向参考。")

# ---- 4) 检索通道 ----
print("\n" + "=" * 72)
print("4) 检索通道(searchMemories 关键词口径, topK=10)")
print("=" * 72)
for a in ARMS:
    ranks = []
    for i in range(n):
        if (a, i) not in mech:
            continue
        for row in mech[(a, i)]["search"]:
            if row.get("role") == "y-private":
                ranks.append(row["rank"])
    if ranks:
        print(f"{a}: y-private 入 top10 率={len(ranks)/n*100:.1f}%  排名均值={sum(ranks)/len(ranks):.1f}")
    else:
        print(f"{a}: y-private 从未入 top10(话题词不重叠——注入通道才是暴露面)")
