# octo-fetch 重构方案

## 问题陈述

当前 `skills/curated/octo-fetch` 主要存在以下问题：

1. 关键环境参数被硬编码在 skill 文档和脚本中，导致复用性差。
   目前写死了 Chrome 路径、CDP 端口 `9222`、输出目录 `wiki-workspace/raw/`、只能复用已启动 Chrome 等策略。
2. 文档中的部分路径已经失效。
   例如 `SKILL.md` 中引用 `.claude/skills/octo-fetch/...`，但当前仓库并不存在该路径。
3. 脚本职责混杂。
   现有 `start_local_chrome.sh` 实际并不启动 Chrome，而是同时承担浏览器路径探测和 CDP 可达性检查，命名与行为不一致。
4. skill 的“默认值”和“强约束”没有分层。
   `wiki-workspace/raw/`、中文模板、截图要求等应该作为 Octo 默认值保留，但不应全部以不可协商的规则形式硬编码。

本次重构目标是在不改变 `octo-fetch` 默认使用体验的前提下，将它改造成“Octo 默认优先、但可配置”的 skill。

## 对现有项目的影响

本次改动只影响 `skills/curated/octo-fetch` 相关内容，不涉及数据库、服务端接口或应用运行时代码。

受影响范围：

- `skills/curated/octo-fetch/SKILL.md`
  - 重写默认行为、执行流程、约束说明
  - 去掉失效路径和旧的 `9222` 叙述
  - 从 `agent-browser --auto-connect` 切换为显式 `agent-browser --cdp <port>`
- `skills/curated/octo-fetch/scripts/start_local_chrome.sh`
  - 该脚本预计被拆分或替换
- 新增若干 helper 脚本到 `skills/curated/octo-fetch/scripts/`
  - 浏览器路径探测
  - CDP 检查
  - Chrome 启动
  - CDP 确保就绪
  - 输出目录解析
  - slug 生成

潜在兼容点：

- 默认 CDP 端口从 `9222` 迁移到 `9999`
- 默认 profile 改为 `~/.octo/chrome_dir`
- 默认行为从“只复用已有浏览器”改为“先检查、找不到就启动”

兼容策略：

- 保持 skill 名称为 `octo-fetch`
- 保持默认输出根目录为 `wiki-workspace/raw/`
- 保持默认模板字段为中文
- 保持默认产出 Markdown 与 screenshot

## 实现方案

### 一、配置模型

引入一组稳定的 `OCTO_FETCH_*` 环境变量。默认优先级如下：

1. 用户在当前任务中明确指定的参数
2. 环境变量
3. skill 内置默认值

计划支持的配置项：

- `OCTO_FETCH_BROWSER_PATH`
- `OCTO_FETCH_BROWSER_CANDIDATES`
- `OCTO_FETCH_CDP_HOST`
  - 默认：`127.0.0.1`
- `OCTO_FETCH_CDP_PORT`
  - 默认：`9999`
- `OCTO_FETCH_USER_DATA_DIR`
  - 默认：`~/.octo/chrome_dir`
- `OCTO_FETCH_OUTPUT_ROOT`
  - 默认：`<repo-root>/wiki-workspace/raw`
- `OCTO_FETCH_SCREENSHOT_DIR`
  - 默认：`<output-root>/screenshots`
- `OCTO_FETCH_TEMPLATE_LOCALE`
  - 默认：`zh-CN`
- `OCTO_FETCH_REQUIRE_SCREENSHOT`
  - 默认：`true`
- `OCTO_FETCH_WAIT_UNTIL`
  - 默认：`networkidle`
- `OCTO_FETCH_FILENAME_PATTERN`
  - 默认：`{timestamp}-{slug}.md`
- `OCTO_FETCH_SLUG_SOURCE`
  - 默认：`host-title`
- `OCTO_FETCH_EXTRA_CHROME_ARGS`

说明：

- `wiki-workspace/raw/` 和中文模板仍然是长期默认值
- 这些默认值保留在 skill 中，但不再写成不可更改的硬规则

### 二、脚本拆分

将原有脚本按职责拆分为以下文件：

```text
skills/curated/octo-fetch/scripts/
  resolve_browser.sh
  check_cdp.sh
  launch_chrome.sh
  ensure_cdp.sh
  resolve_output_root.sh
  slugify.sh
```

职责定义：

- `resolve_browser.sh`
  - 根据显式配置、候选路径、`command -v` 结果解析浏览器可执行文件
- `check_cdp.sh`
  - 检查指定 host/port 的 `json/version` 是否可达
- `launch_chrome.sh`
  - 使用显式参数启动浏览器
  - 启动命令必须带上：

```bash
"$browser_path" \
  --user-data-dir="$user_data_dir" \
  --remote-debugging-port="$cdp_port" \
  about:blank
```

- `ensure_cdp.sh`
  - 先检测 CDP
  - 如果不可达则自动拉起 Chrome
  - 启动后轮询直到可达或超时
  - 成功后输出当前实际连接信息，失败则返回明确错误
- `resolve_output_root.sh`
  - 优先通过 `git rev-parse --show-toplevel` 定位 repo root
  - 如果不在 git 仓库中，则回退到当前工作目录
- `slugify.sh`
  - 统一生成适合文件名的 slug

### 三、skill 文档重构

`SKILL.md` 将改为以下结构：

1. 适用场景
   - 说明 `octo-fetch` 用于使用本机 Chrome 和 `agent-browser` 抓取网页并落盘
2. 默认行为
   - 默认 Chrome profile：`~/.octo/chrome_dir`
   - 默认 CDP 地址：`127.0.0.1:9999`
   - 默认输出目录：`wiki-workspace/raw/`
   - 默认模板语言：中文
   - 默认保存截图
3. 执行流程
   - 解析配置
   - 解析 Chrome 路径
   - 检查或启动 CDP
   - 使用显式 `agent-browser --cdp "$port"` 执行抓取
   - 保存 Markdown 和截图
4. 不可变约束
   - 不允许伪造抓取结果
   - 抓取失败必须明确报错
   - 输出必须包含 `抓取时间`、`来源`、`最终地址`
   - 多个 URL 默认一页一个文件
   - 如果保存截图，则 Markdown 中必须包含截图引用和 `截图内容`

### 四、抓取命令调整

将文档中的示例和推荐用法从：

```bash
agent-browser --auto-connect ...
```

调整为：

```bash
agent-browser --cdp "$OCTO_FETCH_CDP_PORT" ...
```

调整原因：

- 现在端口默认值已经改为 `9999`
- 端口也允许覆盖
- 显式 `--cdp` 比自动发现更可控，更符合 skill 的可复用目标

### 五、输出格式

第一阶段保持现有 Markdown 结构，继续兼容当前习惯：

```md
# <页面标题或任务名>

- 抓取时间: 2026-04-07T22:30:00+08:00
- 来源: https://example.com/page
- 最终地址: https://example.com/page
- 截图文件: ./screenshots/<actual-screenshot-file>.png

## 内容

<抓取到的正文、结构化信息或整理后的页面内容>

## 截图内容

![页面截图](./screenshots/<actual-screenshot-file>.png)

<截图补充说明>
```

内部实现上按以下稳定字段组织，便于后续扩展：

- `title`
- `fetched_at`
- `source_url`
- `final_url`
- `screenshot_path`
- `content_body`
- `screenshot_notes`

## 代码变更草案

计划修改或新增的文件：

- `skills/curated/octo-fetch/SKILL.md`
- `skills/curated/octo-fetch/scripts/start_local_chrome.sh`
  - 预计删除或替换
- `skills/curated/octo-fetch/scripts/resolve_browser.sh`
- `skills/curated/octo-fetch/scripts/check_cdp.sh`
- `skills/curated/octo-fetch/scripts/launch_chrome.sh`
- `skills/curated/octo-fetch/scripts/ensure_cdp.sh`
- `skills/curated/octo-fetch/scripts/resolve_output_root.sh`
- `skills/curated/octo-fetch/scripts/slugify.sh`

示例：`ensure_cdp.sh` 的核心逻辑大致如下：

```bash
browser_path="$(resolve_browser.sh)"
if check_cdp.sh "$host" "$port"; then
  exit 0
fi

launch_chrome.sh "$browser_path" "$user_data_dir" "$port"

for _ in $(seq 1 30); do
  if check_cdp.sh "$host" "$port"; then
    exit 0
  fi
  sleep 1
done

echo "CDP is not reachable on ${host}:${port}" >&2
exit 1
```

## Todo List

- [x] 重写 `octo-fetch` 的设计说明，区分默认行为与硬约束
- [x] 修复 `SKILL.md` 中失效的 `.claude/skills/...` 路径引用
- [x] 将默认 CDP 端口从 `9222` 迁移为 `9999`
- [x] 将默认 profile 迁移为 `~/.octo/chrome_dir`
- [x] 将抓取命令从 `agent-browser --auto-connect` 调整为显式 `agent-browser --cdp`
- [x] 拆分浏览器路径解析、CDP 检查、Chrome 启动、CDP 确保就绪等 helper 脚本
- [x] 提供输出目录解析与 slug 生成脚本
- [x] 保持 `wiki-workspace/raw/` 和中文模板为长期默认值
- [x] 验证脚本语义和文档引用是否一致
