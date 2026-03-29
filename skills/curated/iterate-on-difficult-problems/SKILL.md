---
name: iterate-on-difficult-problems
description: Use an eval-driven improvement loop to solve hard tasks through iteration. Trigger this skill whenever the user has a difficult optimization problem that needs many passes to get right — such as tuning generated content until it's good enough, improving code performance, refining a piece of writing, or any task where success can be measured with a score. Also trigger when the user says things like "keep improving this", "make it better until...", "run an iteration loop", "eval-driven", "score this", "grade this output", or asks to "iterate until..." and iterate on it.
---

# Iterate on Difficult Problems

Use an **eval-driven improvement loop** to solve hard tasks that need many passes to reach a genuinely good result.

This skill is for problems where:
- Each iteration can be scored (deterministic checks, or an LLM-as-a-judge)
- The best result takes many passes, not just one
- Visual or subjective outputs need both automated checks and human judgment

---

## The Explicit Iteration Loop

Follow this exact structure **every single iteration**:

```
1. Run the evals on the current baseline
2. Identify the biggest failure mode from scores AND artifacts
3. Make ONE focused change that addresses that bottleneck
4. Re-run the evals
5. Log the new scores and whether the change helped
→ Continue until both overall score AND LLM average are above threshold
```

This discipline is crucial. If you change too many things at once, you can't tell which idea improved the score. If you skip logging, the session becomes hard to trust and hard to resume.

---

## Step 1: Define Success First

**Never begin changing anything until you know how success will be measured.**

**Find or create the eval:**
- Look for existing test/eval scripts in the workspace
- If none exist, **ask the AI to generate the evaluation script for you** — describe the checks you want to run and let it write the script
- Combine:
  - *Deterministic checks* — test passes/failures, constraint violations, metrics computed in code
  - *LLM-as-a-judge* — rubric-based scores for qualities that are hard to encode exactly (readability, resemblance, quality, usefulness)

**Tip:** Let the AI generate the evaluation script. Describe what you want to score and let it write a script that returns structured, machine-readable scores. This is faster and produces better evals than writing it yourself.

**Set two explicit stopping rules:**
- Target for the **overall score** (e.g., 90%)
- Separate target for the **LLM-judge average** (e.g., 90%)
- Continue only until **both** are above threshold — not just one

---

## Step 2: The Iteration Loop (Every Time)

For each iteration:

1. **Run the evals** — execute your eval script via `Bash`, capture stdout/stderr and scores
2. **Identify the biggest failure mode** — look at both the scores AND the actual artifact to see what's holding back the score
3. **Make one focused change** — address that specific bottleneck, not everything at once
4. **Re-run the evals** — immediately measure whether the change helped
5. **Log the results** in a running log file (e.g., `iteration_log.md`):
   ```
   ## Iteration Log

   ### Iteration 3
   - Change: [one specific thing you tried]
   - Score before: 72% / LLM: 68%
   - Score after: 81% / LLM: 75%
   - Artifact quality: [better because... / worse because...]
   - Next attempt: [what to try next]
   ```
6. **Decide:** If the new result is better or about the same, build on it. If it's worse, try a different direction.
7. **Repeat** until both scores are above threshold.

---

## Step 3: Inspect the Artifact, Not Just the Logs

Numbers can lie. **Always look at the actual output.**

- If it's code: run it, read it, observe behavior
- If it's an image: use `Read` to inspect it directly
- If it's a document: open and read it
- Compare the current result to the prior best result

This makes the loop much stronger:
- The eval script reports the score
- The artifact shows what the score missed
- The next change is grounded in **both** — not blind iteration

---

## Step 4: Running Log

Keep a **running log file** (e.g., `iteration_log.md`) — it is the handoff for the next session and the self-evaluation record for the current one.

**Do NOT rely on conversation context** — if the session runs long, memory fades. The log is the source of truth.

The log must record:
- Current best scores
- What changed on the last iteration
- What the eval said got better or worse
- What you plan to try next

---

## Constraints

- **Do not stop at the first acceptable result.** The goal is genuinely good, not barely-passing.
- **Do not revert to an earlier version** unless the new result is clearly worse in scores or artifacts.
- **Do not run the eval only** — always inspect the actual output. Numbers can lie; looking at the artifact reveals the truth.
- **Do not let context accumulate** — keep the log written to a file.
- **One change at a time** — this is crucial. You need to know what moved the score so you can build on the right direction.
- **No AGENTS.md in this environment** — skip that step.

---

## Output Format

When the loop is complete or when the user asks for a status report, provide:

```
## Eval-Driven Iteration Results

**Current Best Scores**
- Overall: XX%
- LLM-judge average: XX%
- Target: both > 90%

**Iteration Log**
1. [change] → [score delta]
2. [change] → [score delta]
3. ...

**Remaining Bottlenecks**
- [what's still holding back the score]

**Top Weak Spots**
- [risky areas to watch for]
```

---

## Examples

**"Generate a logo for my startup, then keep improving it until it's really polished."**

→ Write an eval script that scores image quality (LLM judge), generate the image, run the loop, log each version, iterate until score > 90%.

**"This Python script is slow. Keep optimizing it and measuring performance until it's under 100ms."**

→ Write a benchmark script, run the loop — change code, measure, log times, iterate until < 100ms.

**"Keep rewriting this product description until it's engaging and accurate."**

→ Create a rubric, score with LLM-as-a-judge, iterate with each revision, stop when quality score > 90%.

**"Generate a chart, then score it and improve it."**

→ Create an eval that checks data accuracy and visual clarity, generate the chart, run the loop, iterate until both scores pass.
