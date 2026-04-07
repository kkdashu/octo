---
name: octo-fetch
description: Fetch or scrape webpage data with the machine's local Google Chrome and `agent-browser --auto-connect`, then save the result into `wiki-workspace/raw/` as Markdown. Use this skill when the user asks to 打开网页、抓取网页、采集页面内容、归档网页、保存网页正文、截图页面, or browse with the installed Chrome profile instead of a bundled browser. The saved Markdown must include fetch time, source URL, extracted content, and screenshot content.
---

# Octo Fetch

Use this skill when the task is to fetch data from the web with the local Google Chrome app and persist the captured result inside the repository.

## Required workflow

1. Resolve the Google Chrome executable path and verify that a CDP-enabled Chrome is already running on port `9222`.

   Prefer the bundled helper:

   ```bash
   .claude/skills/octo-fetch/scripts/start_local_chrome.sh
   ```

   The script prints the resolved Chrome executable path, then verifies that `http://127.0.0.1:9222/json/version` is reachable.
   The script does not launch Chrome.

   On this machine, the preferred executable is:

   ```bash
   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
   ```

2. Reuse the already-running CDP Chrome on port `9222`.

   Do not launch a new Chrome instance from this skill.
   Do not kill existing Chrome processes.
   Do not switch to another port such as `9223`.

   If the helper script reports that `9222` is unavailable, stop and tell the user to start Chrome manually with CDP enabled before continuing.

   Example manual launch outside this skill:

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --remote-debugging-port=9222
   ```

   That manual command is for the user to run intentionally when needed.
   The skill itself should only reuse an already-running `9222` Chrome.

3. Use `agent-browser --auto-connect` for every browser action.

   Minimum flow:

   ```bash
   repo_root="$(git rev-parse --show-toplevel)"
   mkdir -p "$repo_root/wiki-workspace/raw" "$repo_root/wiki-workspace/raw/screenshots"
   agent-browser --auto-connect open <url>
   agent-browser --auto-connect wait --load networkidle
   agent-browser --auto-connect get title
   agent-browser --auto-connect get url
   agent-browser --auto-connect snapshot -i
   agent-browser --auto-connect screenshot --full --screenshot-dir "$repo_root/wiki-workspace/raw/screenshots"
   ```

   If `agent-browser --auto-connect` fails while `9222` is reachable, stop and report the failure.
   Do not fall back to another port and do not relaunch Chrome.

   When the page needs interaction, continue with the same `--auto-connect` pattern:

   ```bash
   agent-browser --auto-connect snapshot -i
   agent-browser --auto-connect click @e1
   agent-browser --auto-connect fill @e2 "..."
   agent-browser --auto-connect scroll down 800
   agent-browser --auto-connect get text @e3
   ```

4. Save one Markdown file per fetched page under `wiki-workspace/raw/`.

   Filename convention:

   ```text
   <repo-root>/wiki-workspace/raw/YYYYMMDD-HHMMSS-<slug>.md
   ```

   Resolve the repo root with `git rev-parse --show-toplevel`, then derive `<slug>` from the host, page title, or task label.

5. The Markdown file must contain these sections.

   Use this template and keep the field names in Chinese:

   ```md
   # <页面标题或任务名>

   - 抓取时间: 2026-04-07T22:30:00+08:00
   - 来源: https://example.com/page
   - 最终地址: https://example.com/page
   - 截图文件: ./screenshots/<actual-screenshot-file>.png

   ## 内容

   <抓取到的正文、结构化信息或整理后的页面内容，尽量保留原始层级和关键信息，不要只写摘要>

   ## 截图内容

   ![页面截图](./screenshots/<actual-screenshot-file>.png)

   <补充描述截图里能看到但未直接提取成文本的关键信息，例如图表、卡片布局、按钮状态、弹窗内容>
   ```

## Rules

- Always resolve the local Chrome executable path first.
- Always reuse the already-running CDP Chrome on `127.0.0.1:9222`.
- Never launch a new Chrome instance from this skill.
- Never kill Chrome processes from this skill.
- Never switch to another debugging port.
- Always use `agent-browser --auto-connect`, never plain `agent-browser` for the actual fetch flow.
- Always create `<repo-root>/wiki-workspace/raw/` and `<repo-root>/wiki-workspace/raw/screenshots/` when missing.
- Always save the Markdown result inside the project root `wiki-workspace/raw/`.
- Always include `抓取时间` and `来源`.
- Always include a screenshot reference and a `截图内容` section.
- Prefer raw captured content or lightly cleaned structure over a short summary.
- When fetching multiple URLs, save one Markdown file per URL unless the user explicitly wants a merged report.

## Troubleshooting

If `agent-browser --auto-connect` cannot connect, verify that Chrome debugging is reachable:

```bash
curl -s http://127.0.0.1:9222/json/version
```

If that endpoint does not respond, rerun:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
```

Then rerun:

```bash
.claude/skills/octo-fetch/scripts/start_local_chrome.sh
```
