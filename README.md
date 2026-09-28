# persistbench-sycophancy

**余弦门控能降 LLM 记忆谄媚吗？——答案：不能。而且后续两轮实验把「为什么不能」钉死了。**

PersistBench 谄媚切片 × [dsh-mneme](https://github.com/heptaspirit/dsh-mneme) 检索层注入机制的全量实验：
200 样本 × 2 臂，qwen3:8b 本地 CPU 推理，LLM-as-judge 评审。

## 一句话结论

**余弦相似度门控是音量旋钮，不是质量过滤器。** 0.6 阈值对谄媚零作用（FR 差 0.5pp，在评审方差内）；
收紧到 0.75/0.85 能降谄媚，但个性化（注入记忆数）同步崩塌，中间不存在可用工作点。
要「降谄媚保个性化」必须换判别维度：entity 级冲突检测、来源信任级、或注入前 LLM 复核。

## 主结果

| 臂 | sycophancy_FR | mean | avg_mem | n |
|---|---|---|---|---|
| A 全注入（top-15） | 42.7% | 2.37 | 10.7 | 199 |
| B0.6 余弦门控 | 43.2% | 2.39 | 9.1 | 199 |

配对差分：74/198 对评分分歧，方向 **37:37 完全对称** —— 纯评审方差，无系统性偏移。
pilot n=10 曾测得 B0.6 +10pp（更谄媚），全量证实为小样本噪声。

### 三 judge 交叉验证

同一批响应另由两个独立 judge 重评（glm-5.3-flash via API、ZCode/GLM-5.3-Flash 会话 agent）：

| judge | A FR | B0.6 FR | B0.6−A |
|---|---|---|---|
| qwen3:8b | 42.7% | 43.2% | +0.5pp |
| glm-5.3-flash | 52.4% | 56.3% | +4.2pp |
| ZCode/GLM-5.3-Flash | 23.0% | 26.5% | +3.5pp |

**三个 judge 全部给出 B0.6 ≥ A**：门控不降谄媚的结论跨 judge 稳健（绝对 FR 因判读风格
从 23% 到 52% 不等，跨 judge 不可比；judge 间二值一致率 69-73%）。

## v2(2026-09-28~29):剂量-选择拆分 + epistemic 控制臂——「为什么不能」的因果版

回应 #280 讨论的两问,全部 Kaggle T4 × qwen3:8b(n=200/臂,会话内配对差口径):

**E1 剂量-选择拆分(固定 2 条,只换选择规则)**

| 臂 | FR | mean | 注入条数 |
|---|---|---|---|
| A 全注入 | 42.7% | 2.38 | 10.7 |
| K2top(最相关 2 条) | **28.0%** | 1.94 | 2.0 |
| K2bot(最不相关 2 条) | **0.5%** | 1.02 | 2.0 |
| E0 空注入 | 0.5% | 1.01 | 0.0 |

纯选择效应 **−27.5pp(方向 2:75)** ≈ 纯剂量效应 −15.1pp 的两倍;K2bot ≡ 空注入逐数重合。
**「剂量占大头」被证伪,相关度轴无可用工作点升级为因果结论**——谄媚源就是高相关记忆本身。

**E2 trustEpistemicWeighting 控制臂(2×2:重排 × [verified] 前缀)**

| 臂 | FR |
|---|---|
| A 现状 | 40.9% |
| R+ 信任重排 | 40.4%(净功劳 **+0.0pp**,方向 28:29) |
| P [verified] 前缀 | 43.7%(净功劳 **+2.7pp**,方向 30:23) |
| R+P 重排+前缀 | 44.0% |

重排真实生效(修复 saveWithDedupe 丢 epistemic_status 的写入通路缺口后,151/151 注入序改变)
但 FR 纹丝不动——**排序不是判别,换序救不了内容**;`[verified]` 前缀三处同向放大服从
(+2.7~5.4pp),是风险不是功劳。

**三问落点**:判别器只剩内容级候选——实体级冲突检测(query↔memory 换端)、来源信任级、
注入前复核。**读数纪律**:同 prompt 异会话漂移 ~4pp、会话内同题重复 ~3.2pp,<5pp 的
效应先过这两把尺;结论只建立在会话内配对差上。

实验报告笔记本:`e-series-report.ipynb`(五个实验一站式复算 + 四张图 + 方法论收获)。

## 快速开始

```bash
pip install pandas matplotlib jupyter
jupyter notebook analysis-sycophancy-threshold.ipynb
```

笔记本只做**分析**（读 jsonl → 算指标 → 画图），不需要 Ollama。
要重跑评测本身：

```bash
ollama pull qwen3:8b
ollama serve  # 11434
node run-sycophancy.mjs --limit 200 --thresholds 0.6 --gentok 400 --judgetok 900
```

v2 实验(需要 dsh-mneme 包路径做检索管线):

```bash
# E1 剂量-选择拆分(固定 2 条,只换选择规则)
node run-sycophancy.mjs --mneme <dsh-mneme包路径> --mode fixedK --k 2 --limit 200   --gen results-e1-gen.jsonl --judge results-e1-judge.jsonl --gentok 400 --judgetok 900
# E2 epistemic 2×2(标注 sidecar 已附)
node label-epistemic.mjs --limit 200 --out sycophancy-epistemic-labels.jsonl
node run-sycophancy.mjs --mneme <dsh-mneme包路径> --mode epistemic --limit 200   --labels sycophancy-epistemic-labels.jsonl --gen results-e2b-gen.jsonl --judge results-e2b-judge.jsonl
# E9 域门控 oracle 臂(零 LLM,只需嵌入)
node run-vector.mjs --mneme <dsh-mneme包路径> --cross-domain data/cross_domain.jsonl   --beneficial data/beneficial_samples.jsonl --thresholds 0.5,0.6,0.7,0.75 --topk 10 --gate dom
```

没有本地算力?`kaggle/` 里有 T4 全套(PORT.md 八条踩坑 + runner notebook),零 API 额度。

断点安全：脚本按 key 去重，中断后重复同一条命令自动续跑。

## 文件

| 文件 | 内容 |
|---|---|
| `analysis-sycophancy-threshold.ipynb` | 全量分析笔记本（主结果 / 配对差分 / Pareto 全景 / 局限） |
| `e-series-report.ipynb` | v2 报告笔记本：剂量-选择拆分 / epistemic 2×2 / heat 曲线拟合 / 域门控天花板 |
| `results-e1-{gen,judge}.jsonl` | E1 fixedK 两臂（800+800 行：A / K2top / K2bot / E0 × 200 样本） |
| `results-e2-{gen,judge}.jsonl` | E2 第一跑（604 行；R+ 臂因写入通路 bug 作废,作 bug 现场留存） |
| `results-e2b-{gen,judge}.jsonl` | E2 终跑（604 行,修复后:重排真实生效 151/151） |
| `sycophancy-epistemic-labels.jsonl` | epistemic_status 显式标注 sidecar（195/200 有效） |
| `label-epistemic.mjs` + `protocol-epistemic-labeler.txt` | 标注协议与脚本（英文样本显式预填） |
| `run-vector.mjs` + `data/cross_domain.jsonl` + `data/beneficial_samples.jsonl` | E9 域门控 oracle 臂（`--gate dom`） |
| `heat-fit-results.json` | E4 heat 曲线拟合聚合结果（幂律 vs 广义指数,per-type β/λ） |
| `kaggle/` | Kaggle GPU 复现全套(PORT.md 踩坑八条 + runner notebook,零 API 额度) |
| `RESULTS.md` | 完整实验记录：pilot → 高阈值档 → 全量，含崩溃现场与口径说明 |
| `run-sycophancy.mjs` | 两阶段评测脚本（G 生成 → J 评审，Node 原生 fetch，无依赖） |
| `results-sycophancy-gen.jsonl` | G 阶段输出（420 行：query / 注入记忆 / 模型回复） |
| `results-sycophancy-judge.jsonl` | J 阶段输出（420 行：逐样本评分 + 理由） |
| `data/sycophancy.jsonl` | 基准样本（来自 inspect_evals PersistBench） |
| `protocol-*.txt/py` | generator / judge / scorer 协议（自 inspect_evals 拷入） |

## 实验设计要点

- **两阶段**：G 全部生成 → J 全部评审，保住 llama.cpp 的 prompt 前缀缓存（评审提示 ~5k token）；
- **judge 口径**：FR = 打分 ≥ 3 的比例（4 = 完全顺着用户错误前提走）；
- **已知混杂**：TRUNC 45%（gentok 400 下生成截断，对两臂同向）；judge null 2/840 行；
- **盲测卫生**：记忆池按构造含谄媚诱饵（cos 0.805 顶 top1），B0.85 空注入对照验证了
  FR 60%→0% 确实来自注入记忆而非 query 本身。

## 口径说明（重要）

脚本汇总与笔记本主表用 **per-arm 口径**（n=199，剔除 judge null）；
配对分析用两臂都有效的 **198 对**。两者结论一致，数字差 ~0.5pp 属口径差异，RESULTS.md 有逐条说明。

## License

数据、笔记本与文档以 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 提供：
使用时请署名（modusensus / slow-stack）并标注原仓库。评测脚本同样按 CC BY 4.0 发布。
