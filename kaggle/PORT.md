# Kaggle 移植手册（E1/E2 跑数，零 API 额度）

> 2026-09-28。目标：把谄媚切片的 G/J 两阶段从本机 CPU Ollama 搬到 Kaggle 免费 GPU
>（T4/T4x2），生成与评审继续用 qwen3:8b——旧缓存（A/B0.6/B0.75/B0.85 n=198 +
> 420 条响应）全部可比，#280 草稿的「复用同批响应」设计原样成立。零密钥上 Kaggle。

## 为什么是 Kaggle 而不是全 API

- 本机纯 CPU 是上一轮 2 天全量跑的瓶颈（G ~2min/条、J ~200s/条、Ollama 内存压力崩）；
- 全 API 模式额度不够（用户约束），且换 glm 生成器 = 全臂重跑、旧缓存报废；
- Kaggle GPU 上 qwen3:8b 估计 G ~15-30s/条、J ~30-60s/条，E1 全量（800+800 调用）
  预计单会话 ~8h（T4x2 双卡双进程可再对半），12h 会话上限内可收。

## 数据集布局（上传三个 Dataset）

| Dataset 名 | 内容 | 来源 |
|---|---|---|
| `dsh-mneme-src` | 仓库 `dsh-mneme/` 包目录（src/ scripts/ package.json，**不含 node_modules**） | git archive 或工作树拷贝 |
| `persistbench-harness` | `evals/persistbench-mneme/` 的脚本 + protocol-*.txt + data/*.jsonl | 本目录（不含 results-*） |
| `persistbench-cached` | 旧 results jsonl（results-sycophancy-gen/judge.jsonl 等，E1 的 A 臂缓存复用用） | 本机输出 |

## Notebook（`e1-e2-runner.ipynb`）四步

1. **Node 24**：conda-forge 装 nodejs（node:sqlite 免 flag 需 ≥23.4）；`node -e "new (require('node:sqlite').DatabaseSync)(':memory:')"` 自检。
2. **Ollama + qwen3:8b**：install.sh → `ollama serve &` → pull（~5GB，几分钟）；`nvidia-smi` 确认 T4 可见。
3. **工作区 + 运行时**：把三个 Dataset 拷到 `/kaggle/working/mneme-stack/`（可写层）；
   包内 `npm install`；**transformers 运行时收编**——本机 payload 是 win32-x64 不能搬，
   Kaggle 上 `npm i @huggingface/transformers@^4.2.0` 后
   `node scripts/mneme-runtime.mjs adopt --from <那个 node_modules>` + `verify`
   （三层解析器 ① 层，linux-x64 原生件随 npm 拉）。
4. **跑**：`RUN` 变量选阶段（SMOKE → E1_PILOT → E1_FULL / E2_LABEL → E2_RUN）。

## 断点续跑（12h 会话管理）

- harness 的 append + 行键去重（`loadJsonl` seen-set）天然续跑：会话被掐 →
  下载 `/kaggle/working/` 的 results-*.jsonl → 传成 Dataset 新版本 → 下一会话
  重跑同一条命令，已完成的 (idx, arm) 键自动跳过。
- judge 的 null 行会挡续跑（judgeDone 只认键存在）：续跑前
  `grep -v '"score":null' results-e1-judge.jsonl` 清理后用更大 `--judgetok` 补
  （本机踩过的坑，Kaggle 同样适用）。
- E1 的 PILOT 与 FULL 共用同一对文件（results-e1-*.jsonl）：pilot 的 10 样本
  自动被 FULL 复用，不用重跑。

## 阶段命令（notebook 内 RUN 分发）

| RUN | 命令 | 产出 |
|---|---|---|
| SMOKE | fixedK limit 2 → results-smoke-*.jsonl | 4 臂 × 2 全链路验证 |
| E1_PILOT | fixedK k=2 limit 10 → results-e1-*.jsonl | A/K2top/K2bot/E0 × 10 |
| E1_FULL | fixedK k=2 limit 200（续 E1_PILOT 文件） | × 200 |
| E2_LABEL | label-epistemic.mjs → data/sycophancy-epistemic-labels.jsonl | 200 条显式标注 |
| E2_RUN | epistemic limit 200 → results-e2-*.jsonl | A/R+/R+P/P × 200 |

E2 的 A 臂与 E1/threshold 模式的 A 缓存互通（键同为 `<idx>:A`，prompt 逐字节相同）。

## 与本机跑的口径一致性

- 模型同 qwen3:8b、temperature 0、think:false、num_ctx 16384 ——与 9-22/9-24 全量
  相同；GPU vs CPU 不改变采样（温度 0 下数值实现差异理论上存在，pilot 里与旧 A 臂
  缓存对拍几条即可确认无漂移：idx0-9 的 A 臂响应应与缓存逐字节一致，若不一致
  说明 ollama 版本采样实现变了，全体臂在同会话内重跑即可，配对差口径不受影响）。
- 评分协议、judge 提示、FR 判据（score ≥ 3）全部不动。

## 伦理与隐私

- 上 Kaggle 的 data/*.jsonl 是 inspect_evals 合成样本（CC BY 4.0），无真实用户数据；
- 不上传任何真实记忆库内容；不带 API 密钥（零密钥跑）。

## 实战踩坑录(2026-09-28,v1–v9 迭代)

1. **鉴权**:新式 KGAT token(前缀 KGAT)不吃 Basic auth——写入 `~/.kaggle/access_token` 配 CLI 2.x;legacy kaggle.json 的 key 对 v1/v2 的 blob 上传端点都 401(读正常)。CLI 2.x 需 `kagglesdk` 配套升级,否则 ImportError。
2. **挂载布局变了**:`/kaggle/input/<slug>` 不存在——CLI 2.x 推的 kernel 把 dataset 挂在 `/kaggle/input/datasets/<user>/<slug>/`。代码按标记文件(package.json / run-sycophancy.mjs)动态发现,别写死路径。
3. **ollama install.sh 需要 zstd**:新版发布包是 zstd 压缩,Kaggle 镜像没装,先 `apt-get install -y zstd`(install.sh 的报错本身会提示)。装完 0.34.4 正常,T4 GPU 直接可用。
4. **`%%bash` 必须是 cell 第一行**——注释放它前面 = Python SyntaxError。Kaggle 的 bash cell 非零退出会炸整个 run(papermill CalledProcessError),结尾显式 `exit 0`。
5. **conda 不存在**(Save & Run 环境),Node 用 nodejs.org tarball 直装(24.15.0 验证通过,node:sqlite 免 flag)。
6. **/kaggle/tmp 也会被持久化到输出**——30k 个 node_modules 文件把 output 下载淹了 6 分钟。工作区放 /kaggle/tmp 没关系(反正被捕获),但**输出下载前先用 kernels_list_files 思路评估体积**,或干脆只往 /kaggle/working 放 results 和日志。实践:workspace /kaggle/tmp,收尾 cell 只拷 results-*.jsonl + diagnostics。
7. **GPU 实测速度**(qwen3:8b,T4):G 阶段 11–12s/条(首次 A 臂 112s 含模型上卡),J 阶段 8–17s/条——E1 全量(800G+800J)约 3.5h,单会话绰绰有余。gentok 350 全 TRUNC(qwen3:8b 常写 400+,与口径无关,两臂同向)。
8. **诊断模式**:diagnostics.txt(node/ollama/api/runtime_payloads/results_copied)+ 每步 `*_exit.txt` + logs/*.log,全部持久化到 /kaggle/working,失败不用猜。
