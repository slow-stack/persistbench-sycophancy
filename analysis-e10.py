#!/usr/bin/env python3
r"""E10 EdgeMem 考卷归因分析:零 LLM 原样写入(Z0) vs 蒸馏(Z1) vs 蒸馏+叙述条(Z2)。

输入:
  data/edgemem_sessions.jsonl   30 会话(5 场景 × 6 变体,4 桥接事实+QA 各 120)
  results-e10-mech.jsonl        各臂库内桥接事实存活(survival 数组) + 条目数
  results-e10-gen.jsonl         G 行(arm/qa 级:injected_fact + response)
  results-e10-judge.jsonl       J 行(arm/会话级 verdicts + counts)

读数(plan 预注册):
  1) 库内存活(机械,零 LLM):Z0 恒 100%(构造保证);Z1 = 蒸馏细节存活率——「提前压缩
     丢细节」的机制层读数;Z2 = Z1 + 叙述条(不改变原子条,核对一致);
  2) 注入层:injected_fact 率(桥接事实进 top-5 的比例,注入运气分量);
  3) QA 保真(judge):full(2)/partial(1)/zero(0) 率 + 答案 marker 命中(机械);
  4) 配对判据:Z0−Z1、Z2−Z1 的会话级配对差(过噪声尺);
  5) 成本轴:构建期 LLM 调用数 Z0=0 / Z1=30 / Z2=60,质量-成本平面。
"""
import json, re, sys

ARMS = ["Z0", "Z1", "Z2"]
dmatch = lambda mk, t: bool(re.search(r"(?<![0-9])" + re.escape(mk) + r"(?![0-9])", t)) if mk else False

def jload(p):
    try:
        return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
    except FileNotFoundError:
        sys.exit(f"missing {p}")

bench = {int(r["idx"]): r for r in jload("data/edgemem_sessions.jsonl")}
mech = {(r["idx"], r["arm"]): r for r in jload("results-e10-mech.jsonl")}
gen = {(r["arm"], int(r["idx"]), r["qi"]): r for r in jload("results-e10-gen.jsonl") if "arm" in r}
jud = {(r["arm"], int(r["idx"])): r for r in jload("results-e10-judge.jsonl")}

n = len(bench)
print(f"覆盖: 会话 {n}; mech {len(mech)} (满配 {3*n}); gen {len(gen)} (满配 {4*3*n} 含 build 行); judge {len(jud)} (满配 {3*n})")

# ---- 1) 库内存活(机械) ----
print("\n" + "=" * 74)
print("1) 库内桥接事实存活(机械 marker;Z0 恒 100% 是构造保证,真正的读数是 Z1)")
print("=" * 74)
surv = {}
for a in ARMS:
    rows = [mech[(i, a)] for i in range(n) if (i, a) in mech]
    if not rows:
        continue
    hit = sum(sum(1 for s in r["survival"] if s) for r in rows)
    tot = sum(len(r["survival"]) for r in rows)
    surv[a] = hit / tot * 100
    nent = sum(r["n_entries"] for r in rows) / len(rows)
    print(f"{a}: 存活率={surv[a]:.1f}%  ({hit}/{tot})  平均条目数={nent:.1f}")

# ---- 2) 注入层 ----
print("\n" + "=" * 74)
print("2) 注入层:桥接事实进 top-5 的比例(注入运气分量)")
print("=" * 74)
inj_rate = {}
for a in ARMS:
    vals = [gen[(a, i, qi)]["injected_fact"] for i in range(n) for qi in range(4) if (a, i, qi) in gen]
    if vals:
        inj_rate[a] = sum(1 for v in vals if v) / len(vals) * 100
        print(f"{a}: injected_fact={inj_rate[a]:.1f}%  (n={len(vals)})")

# ---- 3) QA 保真 ----
print("\n" + "=" * 74)
print("3) QA 保真(judge 0-2 + 答案 marker 机械)")
print("=" * 74)
qa = {}
for a in ARMS:
    jrows = [jud[(a, i)] for i in range(n) if (a, i) in jud]
    if not jrows:
        continue
    f = sum(r["counts"]["full"] for r in jrows)
    p = sum(r["counts"]["partial"] for r in jrows)
    z = sum(r["counts"]["zero"] for r in jrows)
    t = f + p + z
    mh = mt = 0
    for i in range(n):
        for qi in range(4):
            g = gen.get((a, i, qi))
            if not g:
                continue
            m = bench[i]["qa"][qi]["marker"]
            mt += 1
            if dmatch(m, g["response"]):
                mh += 1
    qa[a] = {"full": f / t * 100, "score2plus1": (f + p) / t * 100, "mech": mh / mt * 100, "n": t}
    print(f"{a}: full(2分)={qa[a]['full']:.1f}%  (full+partial)={qa[a]['score2plus1']:.1f}%  "
          f"答案marker命中={qa[a]['mech']:.1f}%  (n={t})")

# ---- 4) 配对判据 ----
print("\n" + "=" * 74)
print("4) 会话级配对差(判据:|差|>=5pp 定方向)")
print("=" * 74)
def session_fidelity(a, i):
    r = jud.get((a, i))
    if not r:
        return None
    vs = r["verdicts"]
    if not vs:
        return None
    return sum(v["score"] for v in vs) / (2 * len(vs)) * 100

for a, b in [("Z1", "Z0"), ("Z2", "Z1"), ("Z0", "Z2")]:
    pairs = [(session_fidelity(a, i), session_fidelity(b, i)) for i in range(n)]
    pairs = [(x, y) for x, y in pairs if x is not None and y is not None]
    if not pairs:
        continue
    d = sum(y - x for x, y in pairs) / len(pairs)
    w = sum(1 for x, y in pairs if y > x)
    l = sum(1 for x, y in pairs if y < x)
    print(f"{b} - {a}: d保真={d:+.1f}pp  方向(更好:更差:平)={w}:{l}:{len(pairs)-w-l}  (n={len(pairs)})")

# ---- 5) 成本轴 ----
print("\n" + "=" * 74)
print("5) 质量-成本平面(构建期 LLM 调用,不含判卷)")
print("=" * 74)
cost = {"Z0": 0, "Z1": n, "Z2": 2 * n}
for a in ARMS:
    if a in qa:
        print(f"{a}: 构建调用={cost[a]:3d}  QA full={qa[a]['full']:.1f}%  库内存活={surv.get(a, float('nan')):.1f}%")
