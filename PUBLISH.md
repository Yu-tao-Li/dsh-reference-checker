# 发布流程：GitHub + 插件商城（dshmarket）

流程沿用 [dsh-computer-use-win](../dsh-computer-use-win)（同作者）的发布路径，
调研自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（插件商城 [dshmarket](https://github.com/dsh-market/dsh-market) 的数据源）及其
`contributing.md`。

## 上架要求（列表仓库 CI 自动检查）

1. `package.json` 声明 `dsh.bundle` manifest（✅ 本仓库已声明）；
2. 仓库**创建满 1 天**且**提交数 ≥ 10**（本仓库初始推送即 11 个提交）；
3. 仓库带 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic（✅ 已加）；
4. 真实可用代码，非占位仓库（✅ 有 CI + 测试套件）。

上架 = 往 `awesome-dsh-plugin` 仓库的 `data/plugins/<owner>__<repo>.yml`
加一个文件（一插件一文件，永不冲突）+ 重新生成其 README，一起提 PR；
合并后网站/商城自动重建。

## 本仓库的文件齐备度

| 文件 | 作用 |
|---|---|
| `package.json` | `dsh.bundle` manifest + `files` + metadata（repository/author/engines） |
| `cordis.patch.yml` | 单行挂载补丁（按包名解析，任何 profile / `$DSH_HOME` 可装） |
| `lib/host.mjs` | 本体（单文件 ESM：提取 + 核对 + 判定 + 样式模板） |
| `test-smoke.mjs` / `test-e2e.mjs` | 离线 / 在线测试套件 |
| `LICENSE` / `THIRD_PARTY.md` | MIT + 依赖（pdf-parse）来源声明 |
| `.github/workflows/ci.yml` | ubuntu-latest 跑离线 smoke（跨平台插件，无需 Windows 运行器） |
| `assets/screenshot-1.png` | 商城截图（raw.githubusercontent 可直链，`scripts/make-screenshot.ps1` 可重生成） |
| `docs/dev-notes.md` | 设计原理、打分公式、踩坑记录 |
| `publish/awesome-list-entry.yml` | 收录条目（PR 里直接用） |
| `publish/screenshots.json` | 截图清单片段（PR 里合并进列表仓库） |

## 步骤留档

### 第 1 步：推 GitHub

- 仓库：<https://github.com/Yu-tao-Li/dsh-refcheck>（public）
- topic `dsh-plugin` 已添加
- 创建/推送命令（留档）：

```powershell
gh repo create dsh-refcheck --public --source . --push
gh repo edit Yu-tao-Li/dsh-refcheck --add-topic dsh-plugin
```

### 第 2 步：GitHub Release（预构建 tarball，安装免构建授权）

```powershell
# 在 lib 包目录打 tgz，挂到 Release
cd dsh-refcheck
npm pack   # → dsh-refcheck-1.0.2.tgz
gh release create v1.0.2 ..\dist\dsh-refcheck-1.0.2.tgz --title "dsh-refcheck v1.0.2"
```

收录条目可加：

```yaml
tarball: https://github.com/Yu-tao-Li/dsh-refcheck/releases/latest/download/dsh-refcheck-1.0.2.tgz
```

### 第 3 步：等够"仓库年龄"

CI 要求仓库**创建满 1 天**。今天推、明天（或更晚）再提收录 PR，避免白跑 CI。

### 第 4 步：提收录 PR（满 1 天后）

```bash
git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
cd awesome-dsh-plugin
# 1) 收录条目（内容见本仓库 publish/awesome-list-entry.yml）
mkdir -p data/plugins
cp <本仓库>/publish/awesome-list-entry.yml data/plugins/Yu-tao-Li__dsh-refcheck.yml
# 2)（可选）截图：把 publish/screenshots.json 的内容合并进 data/screenshots.json
# 3) 重新生成 README（必须，CI 会校验）
npm ci
node scripts/generate-readme.mjs
# 4) 提交 + 推送 + 开 PR
git add data/plugins/Yu-tao-Li__dsh-refcheck.yml data/screenshots.json README.md README.zh.md
git commit -m "Add Yu-tao-Li/dsh-refcheck"
git push origin HEAD
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add Yu-tao-Li/dsh-refcheck" \
  --body "Reference verification for DSH: per-entry Crossref/OpenAlex/arXiv checks with corrected citations in the input's style."
```

### 第 5 步：CI 会检查什么（失败就在同一分支推修复）

1. `dsh.bundle` —— 从本仓库 `package.json` 拉取校验 ✅（已声明）；
2. 仓库年龄 / 提交数 —— 1 天 / 10 次（第 3 步等够即可）；
3. `awesome-lint` + 站点构建 —— 双语描述一致、分隔符、截图 URL 合法性。

### 第 6 步（合并后，自动）

网站与 dshmarket 自动重建，插件即上架。用户侧：

```powershell
dsh plugin --profile web add github:Yu-tao-Li/dsh-refcheck
# 或在 DSH 设置里的插件市场（dshmarket）搜索 "dsh-refcheck" 一键安装
```

### 可选加分项

- **npm 发布**：`npm publish`（包名 `dsh-refcheck` 发布前需
  `npm whoami` 确认账号与名字占用情况；发布后条目 `npm:` 字段自动生效，
  安装免构建授权）。
- **徽章**：上架后 README 双语版各加
  `[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)`。

## 安全提醒

- 上架 ≠ 安全审查（列表官方免责声明）。插件只读用户给的文件、
  网络访问仅限 Crossref/OpenAlex/arXiv 三个公开 API。
- GitHub token 只存 `E:\PythonFiles\.secrets\` 与 git/gh 凭据管理器，
  **不在仓库内**（`.gitignore` 已排除 `.secrets/`）。
