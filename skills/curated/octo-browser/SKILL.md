---
name: octo-browser
description: Operate the machine's local Google Chrome with `agent-browser`, then record important browsing information under `~/.octo/browser/`. Use this skill when the user asks to 打开网页、浏览网页、操作浏览器、抓取页面信息、保存浏览记录、截图页面, or browse with the installed Chrome profile instead of a bundled browser. Each browsing session should save raw information, a cleaned summary, and screenshots when relevant.
---

# Octo Browser

Use this skill when the task is to operate the local Google Chrome app and record important browsing information outside the repository.

## Default behavior

- Default browser profile: `~/.octo/chrome_dir`
- Default CDP host: `127.0.0.1`
- Default CDP port: `9999`
- Default storage root: `~/.octo/browser/`
- Default storage layout: one dated directory per day, one session directory per browsing task
- Default screenshot directory: `<session-dir>/screenshots/`
- Default screenshot behavior: save screenshots when they materially help preserve the browsing record

These are Octo defaults. Keep them unless the user explicitly asks for something different.

## Required workflow

1. Resolve the local Chrome executable path.

   Prefer the bundled helper:

   ```bash
   skills/curated/octo-browser/scripts/resolve_browser.sh
   ```

2. Ensure a CDP-enabled Chrome is reachable on the configured host and port.

   Prefer the bundled helper:

   ```bash
   skills/curated/octo-browser/scripts/ensure_cdp.sh
   ```

   Defaults:

   ```bash
   OCTO_BROWSER_CDP_HOST=127.0.0.1
   OCTO_BROWSER_CDP_PORT=9999
   OCTO_BROWSER_USER_DATA_DIR="$HOME/.octo/chrome_dir"
   ```

   Behavior:

   - First check `http://127.0.0.1:9999/json/version`
   - If reachable, reuse the existing browser
   - If unreachable, resolve Chrome and launch it with:

   ```bash
   "<chrome-path>" \
     --user-data-dir="$HOME/.octo/chrome_dir" \
     --remote-debugging-port=9999 \
     about:blank
   ```

3. Create a browsing session directory under `~/.octo/browser/`.

   Prefer the bundled helpers:

   ```bash
   storage_root="$(skills/curated/octo-browser/scripts/resolve_storage_root.sh)"
   session_dir="$(skills/curated/octo-browser/scripts/create_session_dir.sh "task-or-page-title")"
   screenshot_dir="${OCTO_BROWSER_SCREENSHOT_DIR:-$session_dir/screenshots}"
   ```

   Default layout:

   ```text
   ~/.octo/browser/YYYY-MM-DD/HHMMSS-<slug>/
   ```

4. Use `agent-browser --cdp <port>` for browser actions.

   Minimum flow:

   ```bash
   session_dir="$(skills/curated/octo-browser/scripts/create_session_dir.sh "task-or-page-title")"
   screenshot_dir="${OCTO_BROWSER_SCREENSHOT_DIR:-$session_dir/screenshots}"

   agent-browser --cdp "${OCTO_BROWSER_CDP_PORT:-9999}" open <url>
   agent-browser --cdp "${OCTO_BROWSER_CDP_PORT:-9999}" wait --load "${OCTO_BROWSER_WAIT_UNTIL:-networkidle}"
   agent-browser --cdp "${OCTO_BROWSER_CDP_PORT:-9999}" get title
   agent-browser --cdp "${OCTO_BROWSER_CDP_PORT:-9999}" get url
   agent-browser --cdp "${OCTO_BROWSER_CDP_PORT:-9999}" snapshot -i
   agent-browser --cdp "${OCTO_BROWSER_CDP_PORT:-9999}" screenshot --full --screenshot-dir "$screenshot_dir"
   ```

   When the page needs interaction, continue with the same explicit `--cdp` pattern.

5. Save both raw information and cleaned information for the browsing session.

   Save these files under the session directory:

   ```text
   <session-dir>/raw.md
   <session-dir>/summary.md
   <session-dir>/screenshots/<actual-screenshot-file>.png
   ```

6. The raw record must preserve source details and raw page information.

   Recommended `raw.md` template:

   ```md
   # <页面标题或任务名>

   - 记录时间: 2026-04-10T10:30:00+08:00
   - 来源: https://example.com/page
   - 最终地址: https://example.com/page
   - 会话目录: ~/.octo/browser/2026-04-10/103000-example-page
   - 截图文件: ./screenshots/<actual-screenshot-file>.png

   ## 原始内容

   <页面正文、结构化信息、关键状态、交互结果，尽量保留原始层级和关键信息，不要只写摘要>

   ## 截图内容

   ![页面截图](./screenshots/<actual-screenshot-file>.png)

   <截图里能看到但未直接提取成文本的关键信息>
   ```

7. The cleaned record must highlight what matters after browsing.

   Recommended `summary.md` template:

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

## Configurable values

These values may be overridden when needed:

- `OCTO_BROWSER_PATH`
- `OCTO_BROWSER_CANDIDATES`
- `OCTO_BROWSER_CDP_HOST`
- `OCTO_BROWSER_CDP_PORT`
- `OCTO_BROWSER_USER_DATA_DIR`
- `OCTO_BROWSER_STORAGE_ROOT`
- `OCTO_BROWSER_SCREENSHOT_DIR`
- `OCTO_BROWSER_REQUIRE_SCREENSHOT`
- `OCTO_BROWSER_WAIT_UNTIL`
- `OCTO_BROWSER_FILENAME_SLUG_SOURCE`
- `OCTO_BROWSER_EXTRA_CHROME_ARGS`

## Rules

- Always resolve the local Chrome executable path first.
- Always ensure CDP is reachable before running `agent-browser`.
- Always record important browsing information under `~/.octo/browser/` by default.
- Always organize records by date and per-session directories.
- Always save both `raw.md` and `summary.md` for a meaningful browsing task.
- Always include `记录时间`, `来源`, and `最终地址`.
- If screenshots are used, save them under the session directory and reference them from the record files.
- Prefer preserving raw content in `raw.md` and distilled conclusions in `summary.md`.
- Never pretend the browsing or capture succeeded if Chrome or `agent-browser` failed.

## Troubleshooting

If CDP is not reachable, run:

```bash
skills/curated/octo-browser/scripts/ensure_cdp.sh
```

If you need to inspect the current endpoint manually:

```bash
curl -s "http://${OCTO_BROWSER_CDP_HOST:-127.0.0.1}:${OCTO_BROWSER_CDP_PORT:-9999}/json/version"
```

If Chrome still cannot be started, verify the browser path first:

```bash
skills/curated/octo-browser/scripts/resolve_browser.sh
```
