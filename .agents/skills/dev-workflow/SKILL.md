---
name: dev-workflow
description: Enforces a strict plan-before-code development workflow. Use this skill when the user asks to implement a new feature, fix a bug, or execute a development task. It requires writing a specification document first, getting user review, and iterating on the plan before writing any code.
---

# Dev Workflow

This skill enforces a strict "Planning and Approval before Implementation" workflow. The core principle is never to write code until you've reviewed and approved a written plan.

## The Workflow

When a user asks to build a feature or fix a bug, follow these steps strictly in order. **Never write implementation code until Step 4.**

### Step 1: Research (Understanding the Context)
Before suggesting any changes, deeply read the relevant parts of the codebase.
- Look for existing patterns, architectures, and related components.
- If the user provides a reference implementation, study it carefully.
- Read files deeply, not just surface-level signatures.

### Step 2: Planning (Writing the Spec)
Create a detailed specification document in the `specs` directory (create the directory if it doesn't exist). The file should be named `[feature-name].md`.
** The content of this spec MUST be written in Chinese.**
The spec **must** include:
1. **Problem statement:** What are we trying to solve or build?
2. **Impact on existing project:** What components, databases, or APIs will be affected?
3. **Implementation approach:** Detailed explanation of how this will be implemented, including code snippets, file paths that will be modified, and architectural decisions.
4. **Todo List:** A granular task breakdown with all phases and individual tasks necessary to complete the plan. Use checkboxes (`- [ ]`).

### Step 3: Annotation Cycle (Review and Iterate)
After creating or updating the spec, **STOP**.
- Ask the user to review the spec.
- Wait for the user to provide feedback or inline annotations.
- If the user provides feedback, update the spec document accordingly and ask for review again.
- **DO NOT implement yet.** Keep iterating on the spec until the user explicitly approves it (e.g., by saying "implement it all" or "looks good").

### Step 4: Implementation
Once the user approves the spec, execute the plan.
- Implement every task in the Todo list exactly as specified.
- As you complete a task or phase, mark it as completed (`- [x]`) in the spec document.
- Do not stop until all tasks and phases are completed.
- Keep the code clean (do not add unnecessary comments or jsdocs).
- Maintain strict typing (do not use `any` or unknown types).
- If you encounter unexpected issues that require a fundamental change in approach, stop and ask the user, updating the spec first.

### Step 5: Testing and Verification
After implementation is complete, you must write corresponding tests for the new code or fixes.
- Add or update test cases to cover the newly implemented functionality.
- Run all test cases to ensure they pass successfully.
- Verify that both the new tests and existing test suite pass before considering the task complete.

## Golden Rules
- **No code before approval:** Never write or modify source code files until the `@specs/[feature-name].md` document is explicitly approved by the user.
- **The Plan is the source of truth:** If something is in the plan, implement it. If it's not, don't.
- **Track progress:** Always update the checkboxes in the spec document as you progress through implementation.
