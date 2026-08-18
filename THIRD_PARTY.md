# 第三方依赖与来源（THIRD_PARTY / Provenance）

本项目为**原创实现**，不是任何上游仓库的衍生作品——不存在需要保留的
上游代码版权。运行时仅有一个第三方依赖：

## 运行时依赖

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| [pdf-parse](https://www.npmjs.com/package/pdf-parse) | `^2.4.5`（`package.json` 声明，`package-lock.json` 锁定） | MIT | 提取 PDF 文本层与文档元数据（`.pdf` 输入路径）；ESM `PDFParse` API |

`pdf-parse` 以标准 npm 依赖方式分发（`npm install` / `pnpm add` 时自动拉取），
其 MIT 许可随包内置（`node_modules/pdf-parse/LICENSE`），此处仅登记版本与用途，
不复制其代码。

## 数据源（网络服务，非代码依赖）

核对结果来自三个公开书目 API，均为在线服务（无代码复制、无数据缓存）：

- **Crossref** — https://api.crossref.org（开放书目基础设施）
- **OpenAlex** — https://api.openalex.org（开放学术索引）
- **arXiv** — https://export.arxiv.org（预印本检索 API）

查询仅用标准 GET 请求，带标识性 `User-Agent`（`dsh-reference-checker/<ver>`），
遵守各服务的限流（429 自动重试一次，并发上限 4）。

## 致谢（仅思想层面）

打分与判定思路（标题 token 重合 + 年份/作者加权，"found 从紧、not_found
不等于造假"的诚实上报原则）为通用书目校验做法，未复制任何特定项目的代码。

按 MIT 许可，以上依赖的再分发均被允许；本仓库版权声明见 [LICENSE](LICENSE)。
