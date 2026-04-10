# octo-browser 重构方案

## 问题陈述

当前实现虽然已经把浏览器连接和抓取流程整理出来，但整体语义仍然偏向“抓取网页并归档到仓库”，这和现在的实际用途不完全一致。

新的目标有两个：

1. skill 名称从 `octo-fetch` 调整为 `octo-browser`
   - 新名称更准确地表达“操作用户本机浏览器”的能力范围，而不是单纯抓取网页
2. 信息持久化策略从“写入仓库内的 `wiki-workspace/raw/`”调整为“记录浏览器使用过程中的重要信息到用户目录”
   - 默认持久化根目录改为 `~/.octo/browser`
   - 按日期创建目录
   - 每次浏览记录同时保存“原始信息”和“整理后的信息”

本次重构目标是把这个 skill 明确定位成浏览器操作与浏览记录工具，而不是仓库内网页归档工具。

## 对现有项目的影响

本次改动只影响 `skills/curated/` 下的 skill 目录与相关脚本，不涉及应用运行时代码、数据库或后端接口。

受影响范围：

- skill 目录将从：
  - `skills/curated/octo-fetch/`
  迁移为：
  - `skills/curated/octo-browser/`

- 受影响文件包括：
  - `skills/curated/octo-browser/SKILL.md`
  - `skills/curated/octo-browser/scripts/resolve_browser.sh`
  - `skills/curated/octo-browser/scripts/check_cdp.sh`
  - `skills/curated/octo-browser/scripts/launch_chrome.sh`
  - `skills/curated/octo-browser/scripts/ensure_cdp.sh`
  - `skills/curated/octo-browser/scripts/resolve_storage_root.sh`
  - `skills/curated/octo-browser/scripts/create_session_dir.sh`
  - `skills/curated/octo-browser/scripts/slugify.sh`
  - `skills/curated/octo-browser/scripts/start_local_chrome.sh`

兼容性影响：

- skill 名称从 `octo-fetch` 变为 `octo-browser`
- 环境变量前缀建议同步从 `OCTO_FETCH_*` 迁移为 `OCTO_BROWSER_*`
- 默认输出路径不再位于仓库目录，而改为用户目录 `~/.octo/browser`

需要注意的行为变化：

- 持久化目标从“项目知识库归档”变为“浏览器使用记录”
- 记录将按日期分目录保存，而不是全部平铺到仓库目录中
- 每次记录至少包含两类文件：
  - 原始信息 `raw`
  - 整理后的信息 `summary`

## 实现方案

### 一、skill 重命名

将 skill 从 `octo-fetch` 重命名为 `octo-browser`。

计划调整内容：

- frontmatter 中的 `name` 改为 `octo-browser`
- 文档标题和说明改为 Browser 语义
- 目录从 `skills/curated/octo-fetch/` 迁移到 `skills/curated/octo-browser/`

重命名后的职责描述：

- 连接或启动本机 Chrome
- 通过 `agent-browser` 操作页面
- 记录浏览过程中的重要信息
- 将原始信息与整理结果落盘到 `~/.octo/browser`

### 二、存储模型

默认存储根目录改为：

```text
~/.octo/browser
```

目录结构建议如下：

```text
~/.octo/browser/
  YYYY-MM-DD/
    HHMMSS-<slug>/
      raw.md
      summary.md
      screenshots/
        <actual-screenshot-file>.png
```

说明：

- 第一层按日期分组，例如 `2026-04-10`
- 第二层按单次浏览会话分组，目录名由时间戳和 slug 组成
- `raw.md`
  - 保存原始抓取结果
  - 尽量保留页面结构、页面文本、来源信息、最终地址、截图引用
- `summary.md`
  - 保存整理后的重点信息
  - 以人类可读方式总结本次浏览的关键内容、结论、待跟进事项
- `screenshots/`
  - 保存该次会话的截图文件

这样做的好处：

- 浏览记录不再污染当前仓库
- 浏览历史按日期清晰归档
- 原始信息和整理信息职责清楚，方便后续检索或复盘

### 三、配置模型

环境变量前缀统一调整为 `OCTO_BROWSER_*`。

计划支持的配置项：

- `OCTO_BROWSER_PATH`
- `OCTO_BROWSER_CANDIDATES`
- `OCTO_BROWSER_CDP_HOST`
  - 默认：`127.0.0.1`
- `OCTO_BROWSER_CDP_PORT`
  - 默认：`9999`
- `OCTO_BROWSER_USER_DATA_DIR`
  - 默认：`~/.octo/chrome_dir`
- `OCTO_BROWSER_STORAGE_ROOT`
  - 默认：`~/.octo/browser`
- `OCTO_BROWSER_SCREENSHOT_DIR`
  - 默认：`<session-dir>/screenshots`
- `OCTO_BROWSER_REQUIRE_SCREENSHOT`
  - 默认：`true`
- `OCTO_BROWSER_WAIT_UNTIL`
  - 默认：`networkidle`
- `OCTO_BROWSER_FILENAME_SLUG_SOURCE`
  - 默认：`host-title`
- `OCTO_BROWSER_EXTRA_CHROME_ARGS`

优先级：

1. 用户在当前任务中的显式要求
2. 环境变量
3. skill 默认值

### 四、浏览器连接与启动策略

默认浏览器行为保持现有设计：

- 先解析本机 Chrome 路径
- 检查 `127.0.0.1:9999`
- 如果可达，则复用已运行浏览器
- 如果不可达，则自动启动 Chrome

默认启动参数保持为：

```bash
"$browser_path" \
  --user-data-dir="$HOME/.octo/chrome_dir" \
  --remote-debugging-port=9999 \
  about:blank
```

浏览动作仍然使用显式端口：

```bash
agent-browser --cdp "${OCTO_BROWSER_CDP_PORT:-9999}" ...
```

### 五、记录文件格式

#### 1. `raw.md`

用于保留原始信息，建议模板：

```md
# <页面标题或任务名>

- 记录时间: 2026-04-10T10:30:00+08:00
- 来源: https://example.com/page
- 最终地址: https://example.com/page
- 会话目录: ~/.octo/browser/2026-04-10/103000-example-page/
- 截图文件: ./screenshots/<actual-screenshot-file>.png

## 原始内容

<页面正文、关键文本、结构化信息、交互状态、抓取到的原始要点>

## 截图内容

![页面截图](./screenshots/<actual-screenshot-file>.png)

<截图中能看到但未直接提取成文本的关键信息>
```

#### 2. `summary.md`

用于保存整理后的重要信息，建议模板：

```md
# <页面标题或任务名>

- 记录时间: 2026-04-10T10:30:00+08:00
- 来源: https://example.com/page
- 最终地址: https://example.com/page

## 重要信息

<整理后的重点结论、数据、状态、变更点、后续建议>

## 后续动作

<需要继续跟进的事项，没有则写“无”>
```

### 六、脚本结构

目录结构建议调整为：

```text
skills/curated/octo-browser/
  SKILL.md
  scripts/
    resolve_browser.sh
    check_cdp.sh
    launch_chrome.sh
    ensure_cdp.sh
    resolve_storage_root.sh
    create_session_dir.sh
    slugify.sh
    start_local_chrome.sh
```

脚本职责：

- `resolve_browser.sh`
  - 解析 Chrome 可执行文件路径
- `check_cdp.sh`
  - 检查 CDP host/port 是否可用
- `launch_chrome.sh`
  - 以默认 profile 和端口启动 Chrome
- `ensure_cdp.sh`
  - 检查 CDP，不可达则拉起并等待
- `resolve_storage_root.sh`
  - 解析存储根目录，默认展开为 `~/.octo/browser`
- `create_session_dir.sh`
  - 按日期和时间戳创建单次浏览会话目录，并创建 `screenshots/`
- `slugify.sh`
  - 生成会话目录 slug
- `start_local_chrome.sh`
  - 兼容入口，内部调用 `ensure_cdp.sh`

### 七、代码变更草案

计划执行的文件级改动：

- 新建或迁移目录：
  - `skills/curated/octo-browser/`

- 重写：
  - `skills/curated/octo-browser/SKILL.md`

- 新增或迁移脚本：
  - `skills/curated/octo-browser/scripts/resolve_browser.sh`
  - `skills/curated/octo-browser/scripts/check_cdp.sh`
  - `skills/curated/octo-browser/scripts/launch_chrome.sh`
  - `skills/curated/octo-browser/scripts/ensure_cdp.sh`
  - `skills/curated/octo-browser/scripts/resolve_storage_root.sh`
  - `skills/curated/octo-browser/scripts/create_session_dir.sh`
  - `skills/curated/octo-browser/scripts/slugify.sh`
  - `skills/curated/octo-browser/scripts/start_local_chrome.sh`

实现上会把原先“仓库输出目录”的逻辑删除，改成“浏览记录目录”的逻辑：

```bash
storage_root="${OCTO_BROWSER_STORAGE_ROOT:-$HOME/.octo/browser}"
date_dir="$(date +%F)"
session_dir="${storage_root}/${date_dir}/$(date +%H%M%S)-${slug}"
mkdir -p "${session_dir}/screenshots"
```

然后将内容保存为：

```text
${session_dir}/raw.md
${session_dir}/summary.md
${session_dir}/screenshots/<file>.png
```

## Todo List

- [x] 将 skill 从 `octo-fetch` 重命名为 `octo-browser`
- [x] 调整 skill 文档描述，使其从“网页抓取归档”转为“浏览器操作与浏览记录”
- [x] 将环境变量前缀从 `OCTO_FETCH_*` 迁移为 `OCTO_BROWSER_*`
- [x] 将默认持久化根目录改为 `~/.octo/browser`
- [x] 实现按日期分目录的浏览记录结构
- [x] 实现单次浏览会话目录的命名规则
- [x] 将输出文件拆分为 `raw.md` 和 `summary.md`
- [x] 保留截图并存入会话目录下的 `screenshots/`
- [x] 调整脚本名称和文档引用，从 `octo-fetch` 路径迁移到 `octo-browser`
- [x] 验证脚本语义、文档引用和目录结构是否一致
