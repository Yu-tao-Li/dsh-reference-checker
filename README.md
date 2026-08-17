# DeepSeek Harness 插件：参考文献检查器（dsh-refcheck）

Cordis 插件（host-only，无浏览器 UI）：向模型注册 **`refcheck_check`** 工具。

## 功能

核对一篇论文的参考文献是否真实存在：

- **输入**（二选一）：
  - `references`：粘贴文本——一行一条引用（任意常见样式），或整段 BibTeX
  - `path`：文件路径——`.pdf`（提取文本层 + 自动定位 References 章节）/ `.bib` / `.tex`（thebibliography 块或 `\bibliography{refs}` 指向的 .bib）/ `.txt` `.md` 等其他文本（UTF-8，GBK 自动回退）
- **数据源**：Crossref + OpenAlex + arXiv（并发 4，429 自动重试）
- **判定**：`found` ✅ / `partial` ⚠️ / `not_found` ❌ / `error` ⛔，附最接近的真实记录（标题/年份/出处/卷期页/DOI/链接）
- **格式适配（8 种 + BibTeX + 通用）**：APA、GB/T 7714、IEEE、MLA、Vancouver/AMA、Chicago、Harvard、ACS——自动识别，且**按输入样式生成 `corrected` 更正版引用**（全作者列表、卷期页、DOI），可直接替换回论文
- **注意**：`not_found` = "这三个库里查不到接近收录"，不等于造假（老期刊/内部报告/部分中文期刊同样查不到）

## 安装

```powershell
# 装到 HOME 的 node_modules（宿主 loader 与客户端扫描器都解析得到；部署目录之外，dsh 升级不清）
npm install .\dist\dsh-refcheck-1.0.0.tgz --prefix C:\Users\Administrator
```

## 挂载（一行，加到任意现有组合里——不需要新模式）

```yaml
- id: refcheck
  name: 'dsh-refcheck'
```

## 测试

```powershell
cd dsh-refcheck
npm install            # 拉 pdf-parse
node test-smoke.mjs    # 离线：最小 PDF → 提取 → 四种来源解析
node test-e2e.mjs      # 在线：8 行混合格式真实核对 + 格式/更正版断言
```
