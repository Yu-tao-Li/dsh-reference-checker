# 设计原理与踩坑记录（dev notes）

`lib/host.mjs` 是单文件插件（ESM，宿主进程内加载）。本文档记录关键设计决策、
公式参数和实际踩过的坑，改打分/样式逻辑前先读这里。

## 1. 输入提取（extractReferences）

| 输入 | 路径 | 说明 |
|---|---|---|
| `.pdf` | pdf-parse（懒加载 `import('pdf-parse')`）→ `findReferencesSection` | 懒加载是关键：PDF 库的任何问题都不能破坏 preset 挂载（模块顶层不 import） |
| `.bib` | `parseBibtex`（括号深度扫描） | 支持嵌套花括号（题名里的 `{}`）、`@comment`/`@preamble` 跳过 |
| `.tex` | 先 `thebibliography` 块；再 `\bibliography{a, b}` / `\addbibresource` → 同目录 `.bib` | 两种都失败才退回按纯文本处理 |
| 其他文本 | UTF-8，出现 `\uFFFD` 时回退 GBK | 中文 Windows 记事本存的引用列表通常是 GBK 无 BOM |

**References 章节定位**（`findReferencesSection`）：从文档**末尾向前**扫最近
400 行内的标题行（`references` / `bibliography` / `works cited` / `参考文献` /
`参考资料` / `引用文献`），到 `appendix`/`acknowledg*` 等下一节标题为止。
论文里参考文献永远是靠后的章节，从后往前找比从前往后找稳（避免正文里
"See References" 之类的干扰）。PDF 提取注入的分页线（`-- 2 of 5 --`）
在条目切分时被 `PAGE_SEP_RE` 过滤。

**条目切分**（`splitEntries`）：`[n]` / `(n)` / `n.` 编号开头必为新条目；
否则"看起来像完整引用"的行（任一已知样式能识别）开头即新条目；纯文本行
用作者引导启发式（`Last, F.` / `Last (2017)`）。多行引用（PDF 提取常见）
靠"当前条目已完整才开新条目"收拢。

## 2. 查询构造

- **Crossref**：有（推测的）标题 → `query.title` + `query.author` + 年份
  过滤窗 `from-pub-date:Y-1` ~ `until-pub-date:Y+1`；无标题 →
  `query.bibliographic`（整行，≤600 字符）。`rows=8`。
- **OpenAlex**：`works?search=<title-or-line>（≤200 字符）&per-page=8`。
- **arXiv**：仅当能给出英文标题才查（`ti:"..."`，≤200 字符，`max_results=6`）——
  中文/非英文标题查预印本 API 无意义且浪费配额。

并发：`mapPool`（4 个 worker），每条引用内部三个数据源 `Promise.allSettled`
（一个源挂了不影响另外两个）；HTTP 层 15s 超时、最多 3 跳重定向、
429/500/502/503 自动等 1.5s 重试一次，其余错误直接上抛进 `sources[].error`。

## 3. 标题猜测（guessTitleFromLine）

按样式分策略：GB 取作者块与 `[J]` 标记之间；IEEE/MLA/Chicago 取双引号内
（Harvard 取单引号内）；Vancouver/ACS 先剥作者块；APA/plain 取 `(year)` 之后；
最后统一剥 `In/At + Venue` 尾句与第二句（"…recognition. In CVPR." /
"…all you need. NeurIPS."）。结果 <10 字符视为猜不出（返回 undefined，
此时打分只走 containment——见下）。

## 4. 打分与判定（scoreCandidate / verifyOne）

```
score = 0.72 × t + 0.18 × yearFactor + 0.10 × authorFactor

t（标题重合）：
  规范化 token（小写、去标点、去年份 token、去英文停用词——
  TITLE_STOPWORDS 防短标题被公共词灌水，如 "all you need"）
  ref.title 已知  → max(jaccard, 0.5×jaccard + 0.5×containment)
  仅整行（无干净标题）→ containment（"DB 标题的 token 大多出现在行里"）
yearFactor：|Δyear| ≤ 1 → 1；= 2 → 0.5；≥ 3 → 0（且该候选直接不配 found）
authorFactor：第一作者**姓**（最后一个词）在候选作者串里按词边界命中 → 1
  - 候选没有作者元数据 → 无法判断，不扣分（authorFactor=1）
  - 候选有作者信息但明确不命中 → 0，且置 authorMiss（否决 found）
  - 作者来自启发式（非 bib 字段）→ 软化为 0.5×factor + 0.5
```

判定：

| 状态 | 条件 |
|---|---|
| `found` | `score ≥ 0.80` 且 `t ≥ 0.75` 且年份差 < 3 且 `!authorMiss` |
| `partial` | 未达 found 但 `t ≥ 0.55` |
| `not_found` | 有候选但 `t < 0.55`，或无候选（且至少一个源 ok） |
| `error` | 三个源全部失败（附各自错误） |

**原则：found 从紧。** 误判"真实"比误判"存疑"代价大得多（作者会直接拿
found 当依据）；not_found 则永远配一句"不等于造假"。`t ≥ 0.55` 的
partial 才生成 `corrected`——重合太低的"更正版"其实是另一篇论文，贴回去
反而坏事。

## 5. 样式识别与更正版（detectLineFormat / formatCitation）

识别顺序 = 歧义度从低到高：GB（`[J]/[M]/[D]…` 标记，GB/T 7714 独有）→
IEEE（`[n]`+引号题名，或 `"T" , in V`）→ APA（`Last, F. (Year).`）→
Harvard（`Last, F. (Year) 'T'`）→ Chicago（`Last, First. Year. "T"`）→
Vancouver（`Last AA. … Year;Vol:`）→ MLA（`Last, First. "T"` 无年份前置）→
ACS（`;` 分隔作者 + `Journal Abr. Year, Vol, pages`）→ plain 兜底。

更正版模板按**该条**识别出的样式生成（`plain` 回退 APA）；作者列表上限 12
（IEEE/GB 全列，APA 按 APA 7 规则 `…, & Last`，MLA/Chicago ≥3 人 `et al`）。
BibTeX 输入强制 `bibtex` 模板，key 沿用原条目的 key。

## 6. 踩坑记录

- **非结构化姓名的姓/名切分**（v1.0.2 修）：`splitName` 旧实现把第一个词
  当名、其余当姓，`Aidan N. Gomez` 被拆成 姓=`N. Gomez` → 输出
  `N. Gomez, A.`。修正为**最后一个词是姓**——对 `Given [Middle] Family`
  （arXiv/OpenAlex 的通行格式）与 `A. N. Gomez`（首字母在前）两种形态都正确。
  回归断言在 `test-e2e.mjs`（`multi-word given`）。
- **IEEE 模板残留逗号**（v1.0.2 修）：venue 后无 vol/iss/pages 时输出
  `"T," arXiv preprint, , 2017.`。改为 parts 数组按需 join。
- **BibTeX 的 `firstAuthor`**：`firstAuthorFrom` 取第一个 `and` 段落的
  **最后一个词**（BibTeX 习惯 `Family, Given`）；`leadingAuthor`（整行
  启发式）则剥掉结尾的单字母首字母（`VASWANI A` → `VASWANI`）。
- **`et al.` 残留**：作者块剥除后可能留下 `et al. Title` 前缀，统一在
  猜测标题前剥掉。
- **停用词灌水**：`attention is all you need` 这类短标题对 DB 侧
  "All You Need Is …" 标题的 jaccard 会被公共词抬高/压低，
  `TITLE_STOPWORDS` 先过滤再算（CJK token 天然不在表内，不受影响）。
- **GBK 无 BOM 文件**：UTF-8 解码出现 `\uFFFD` 才回退 GBK——BOM 文件
  走 BOM 分支，避免误判。
- **测试文件的中文**：`test-e2e.mjs` 里若干中文串是历史遗留的双重编码
  （UTF-8 字节被按 GBK 再存了一次），测试自身两侧一致所以能过；**不要
  顺手"修复"它们**，除非同时重跑全量验证。
- **Windows PowerShell 5.1**：无 BOM 的 UTF-8 `.ps1` 按 ANSI 读，
  `scripts/make-screenshot.ps1` 因此刻意纯 ASCII，文案放
  `assets/screenshot-data.json`（`-Encoding UTF8` 显式读取）。

## 7. 版本历史

| 版本 | 变更 |
|---|---|
| 1.0.0 | 首版：提取（PDF/bib/tex/text）+ 三源核对 + 8 样式更正版 |
| 1.0.1 | 本地迭代修正（打包格式/文档） |
| 1.0.2 | `splitName` 姓/名切分修正（多词名）；IEEE 模板残留逗号修正；e2e 增加回归断言 |
| 1.1.0 | 改名 `dsh-refcheck` → `dsh-reference-checker`（全称 + 中文标题）；bundle id 与 User-Agent 同步更新 |
