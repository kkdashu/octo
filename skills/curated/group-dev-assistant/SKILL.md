---
name: group-dev-assistant
description: Group chat AI development assistant for collaborative software projects. This skill should be used when a user in a group conversation requests to onboard a GitHub project, reports a bug, or requests a feature. It handles the full workflow from project cloning to GitHub issue creation, PR submission, implementation, and merge.
---

# Group Dev Assistant

This skill manages AI-assisted software development workflows triggered from group chat conversations. It covers two main scenarios: **project onboarding** and **bug/feature development**.

---

## Scenario 1: Project Onboarding

**Trigger:** A user says something like:
- "帮我开发项目：https://github.com/owner/repo"
- "克隆项目：[github url]"
- "onboard project: [github url]"

### Steps

1. **Parse the GitHub URL** from the user's message.

2. **Determine the target directory.** Projects are cloned into the `projects/` subdirectory of the current working directory (i.e., the group's working directory). The subdirectory name is derived from the repository name:
   ```
   projects/<repo-name>/
   ```

3. **Clone the project:**
   ```bash
   git clone <github-url> projects/<repo-name>
   ```

4. **Confirm success** by replying to the group:
   ```
   ✅ 项目 <repo-name> 已成功获取到 projects/<repo-name>/
   仓库地址：<github-url>
   可以开始提 Bug 或 Feature 需求了！
   ```

5. **Set the cloned project as the active project context** for subsequent bug/feature requests in this conversation.

---

## Scenario 2: Bug Report or Feature Request

**Trigger:** A user in the group describes a bug or requests a feature for the active project. Examples:
- "这个项目有个 bug，登录后跳转页面不对"
- "帮我加个功能：用户可以导出 CSV"
- "fix: 点击按钮没有反应"
- "feature: 增加暗黑模式"

### Steps

#### Step 1: Understand the Requirement

- Read the user's message carefully.
- If the requirement is ambiguous, ask one focused clarifying question before proceeding.
- Identify: (a) which project this applies to, (b) whether it's a bug or feature.

#### Step 2: Research the Codebase

- Navigate to `projects/<repo-name>/` (or the active project directory).
- Read relevant source files to understand the existing code structure and patterns.
- Identify which files and components are affected.

#### Step 3: Write the Spec (dev-workflow)

- Follow the **dev-workflow** skill: create a spec document at `projects/<repo-name>/specs/<feature-or-bug-name>.md`.
- The spec must be written in **Chinese** and include:
  1. 问题描述 (Problem statement)
  2. 对现有项目的影响 (Impact on existing project)
  3. 实现方案 (Implementation approach with file paths and code snippets)
  4. Todo 列表 (Granular task breakdown with checkboxes)

#### Step 4: Create a GitHub Issue

Once the spec is written, create a GitHub issue using the `gh` CLI:

```bash
# For a bug
gh issue create \
  --repo <owner>/<repo> \
  --title "fix: <brief description>" \
  --body "$(cat projects/<repo-name>/specs/<spec-name>.md)" \
  --label "bug"

# For a feature
gh issue create \
  --repo <owner>/<repo> \
  --title "feat: <brief description>" \
  --body "$(cat projects/<repo-name>/specs/<spec-name>.md)" \
  --label "enhancement"
```

- Report the issue URL back to the group:
  ```
  📋 已创建 Issue：<issue-url>
  请确认需求后回复「确认」，我将开始实现并提交 PR。
  ```

#### Step 5: Wait for User Confirmation

**STOP here.** Do not implement until the user explicitly confirms.

Acceptable confirmations: "确认", "ok", "开始", "实现", "lgtm", "looks good", or any affirmative response.

If the user requests changes to the spec, update `specs/<spec-name>.md` and update the GitHub issue body accordingly, then ask for confirmation again.

#### Step 6: Implement the Feature/Fix

Once confirmed:

1. **Create a new branch:**
   ```bash
   cd projects/<repo-name>
   git checkout -b fix/<issue-number>-<slug>   # for bugs
   # or
   git checkout -b feat/<issue-number>-<slug>  # for features
   ```

2. **Implement according to the spec:**
   - Follow every task in the spec's Todo list.
   - Mark completed tasks with `- [x]` in the spec file.
   - Keep code clean: no unnecessary comments, no `any` types.
   - Run existing tests after implementation.

3. **Write or update tests** to cover the new code.

4. **Run all tests and verify they pass.**

5. **Commit changes:**
   ```bash
   git add -A
   git commit -m "fix: <description> (closes #<issue-number>)"
   # or
   git commit -m "feat: <description> (closes #<issue-number>)"
   ```

#### Step 7: Submit a Pull Request

```bash
git push origin <branch-name>

gh pr create \
  --repo <owner>/<repo> \
  --title "fix: <description>" \
  --body "Closes #<issue-number>\n\n## Summary\n<1-3 bullet points>\n\n## Test Plan\n- [ ] All existing tests pass\n- [ ] New tests added for the change" \
  --head <branch-name> \
  --base main
```

Report back to the group:
```
🚀 PR 已提交：<pr-url>
等待 review 和合并，或回复「合并」直接合并。
```

#### Step 8: Merge the PR

When the user says "合并", "merge", "lgtm", or "approve and merge":

```bash
gh pr merge <pr-number> --repo <owner>/<repo> --squash --delete-branch
```

Confirm:
```
✅ PR 已合并！功能上线：<brief feature description>
```

---

## Context Tracking

Throughout the conversation, maintain awareness of:
- **Active project**: which `projects/<repo-name>/` is currently in focus
- **Active spec**: which spec document is in progress
- **Active issue**: the GitHub issue number for the current task
- **Active branch**: the git branch being worked on

If multiple projects have been onboarded, infer the active project from context, or ask the user to clarify.

---

## Golden Rules

- **Never implement before issue confirmation.** Always create the GitHub issue and wait for user approval.
- **The spec is the source of truth.** Implement exactly what's in the spec, nothing more.
- **Reply in the same language as the user.** If the user writes in Chinese, respond in Chinese.
- **Keep group messages concise.** Use short status updates with emojis to signal progress.
- **Never force-push or delete branches without user approval.**
