---
name: knowledge-base
description: Build and maintain a personal wiki knowledge base powered by LLMs. Use this skill whenever the user has source materials (articles, papers, notes, data) in a `raw/` directory and wants to compile them into a structured wiki, ask complex questions against the knowledge base, update or expand existing wiki articles, run health checks on the wiki, or improve the wiki's structure and content over time. Triggers include: "帮我整理知识库", "处理 raw 目录的资料", "更新 wiki", "对知识库做健康检查", "build a wiki", "compile knowledge base", "ask questions about my notes", "wiki health check", "improve my wiki", or any request involving organizing, querying, or maintaining a personal knowledge base.
---

# LLM-Powered Personal Knowledge Base

This skill transforms raw source materials into an LLM-maintained wiki and enables ongoing curation, querying, and improvement of the knowledge base. The LLM acts as the primary author and maintainer of the wiki; the user is the curator and reader.

## Directory Structure

A knowledge base has this structure:

```
<project-root>/
├── raw/                    # Source materials (user-managed)
│   ├── articles/           # Web-clipped or imported articles (.md)
│   ├── papers/             # Research papers, PDFs (as .md summaries)
│   ├── notes/              # User's raw notes and ideas
│   ├── datasets/           # Data files, CSVs, JSON
│   └── images/             # Referenced images (local copies)
├── wiki/                   # LLM-compiled wiki (LLM-managed)
│   ├── index.md            # Wiki overview and navigation
│   ├── concepts/           # Concept-level articles
│   │   ├── _index.md       # Concept index
│   │   └── *.md            # Individual concept articles
│   ├── topics/             # Topic-level organization
│   │   ├── _index.md       # Topic index
│   │   └── *.md            # Topic articles
│   └── references/         # Source references with summaries
│       └── *.md            # One per source in raw/
├── outputs/                # Generated outputs (Q&A, slides, images)
│   ├── qa/                 # Question & answer outputs
│   ├── slides/             # Marp slide decks
│   └── figures/            # Generated matplotlib images
└── tools/                  # Utility scripts
    └── search.py           # Simple wiki search engine
```

## Core Workflows

### 1. Compile Wiki from Raw Materials

When the user says "整理知识库", "编译 wiki", "build wiki from raw", or similar:

**Step 1: Survey raw materials**
- Read all files in `raw/` recursively
- Note file types, topics, and approximate volume
- Identify the main themes and domains

**Step 2: Create wiki structure**
For each source in `raw/`, create a reference entry in `wiki/references/`:
- Summarize the key points (2-4 sentences)
- Extract 3-5 key concepts or terms
- Note connections to other sources

**Step 3: Create concept and topic articles**
- Group related sources into topics
- Write concept articles that explain key ideas
- Add backlinks between related concepts and references
- Create `wiki/index.md` as the entry point

**Step 4: Create indexes**
- `wiki/concepts/_index.md` — list all concepts with brief descriptions
- `wiki/topics/_index.md` — list all topics
- `wiki/references/_index.md` — table of all sources with summaries

**File naming conventions:**
- Use kebab-case: `reinforcement-learning.md`, `llm-finetuning.md`
- Concepts: `wiki/concepts/<concept-name>.md`
- Topics: `wiki/topics/<topic-name>.md`
- References: `wiki/references/<source-name>.md`

**Wiki article template:**
```markdown
# <Title>

## Summary
<Brief overview of this concept/topic in 2-3 sentences>

## Key Points
- <Point 1>
- <Point 2>
- <Point 3>

## Related Concepts
- [[concept-name|Display Name]]

## Source References
- [[references/source-name|Source Name]] — <brief note>

## Further Questions
- <Question the user might want to ask about this>
```

### 2. Answer Questions Against the Wiki

When the user asks a question about their knowledge base:

**Step 1: Understand the query**
Identify what the question is asking and which parts of the wiki are relevant.

**Step 2: Read relevant sources**
- Start with the wiki index and relevant concept/topic articles
- Read the full reference entries for relevant sources
- Read raw files directly if deeper detail is needed

**Step 3: Research and compose answer**
- Synthesize information across multiple sources
- Cite specific sources using wiki-style links: `[[references/source-name]]`
- Acknowledge gaps in the knowledge base where relevant

**Step 4: Offer to file the answer**
Suggest saving the answer as a wiki article or Q&A entry in `outputs/qa/`

**Format for Q&A outputs:**
```markdown
# Q: <Question>

**Answer:**
<Full answer>

**Sources consulted:**
- [[references/source-name]] — <relevant excerpt>
- [[concepts/concept-name]] — <relevant concept>

**Confidence:** High / Medium / Low
*(This confidence reflects how well the wiki covers this topic)*

---
*Generated: <timestamp>*
```

### 3. Update and Expand the Wiki

When the user adds new material to `raw/` or asks to expand the wiki:

**Incremental compilation:**
1. Read the new raw materials
2. Read existing wiki structure (`index.md`, concept/topic indexes)
3. Decide: update existing articles, create new ones, or reorganize
4. Update affected files; create new ones as needed
5. Update all affected indexes

**Expansion patterns:**
- Add new concept articles for novel ideas
- Merge similar concepts if they've grown too overlapping
- Split large articles that cover multiple topics
- Add more backlinks when new connections emerge

### 4. Health Check

When the user says "健康检查", "health check", or "检查 wiki":

Check the following and report findings:

**Consistency:**
- Are there contradicting claims across articles?
- Are links broken or pointing to non-existent files?
- Are summaries in index files still accurate?

**Completeness:**
- Are there sources in `raw/` not yet referenced in the wiki?
- Are there concept articles with placeholder text?
- Are there unresolved "Further Questions" that could be answered?

**Structure:**
- Are articles organized logically?
- Are there orphaned articles (no incoming links)?
- Is the index up to date with the current structure?

**Suggestions:**
- New article candidates from combining concepts
- Missing connections between topics
- Raw materials worth diving deeper into

### 5. Generate Output Formats

When the user wants output in a specific format:

**Markdown file:**
- Create or update a `.md` file in `outputs/` or `wiki/`
- Follow the wiki article template above

**Marp slides (presentation):**
```markdown
---
marp: true
theme: default
paginate: true
---

# <Title>

<!-- Each ## heading becomes a slide -->

## <Slide Title>

- Bullet point 1
- Bullet point 2
```

Save to `outputs/slides/<topic>-<date>.md`

**Matplotlib figure:**
Write a Python script that generates a figure. Save to `outputs/figures/`.
Run it with `bun run <script>.py` (use matplotlib with `pip install matplotlib`).

**After generating, always offer to save the output back into the wiki** if it's valuable for future queries.

## Principles

1. **LLM maintains, user curates.** Write and update the wiki yourself. Only touch the wiki when the user asks, or when the user has explicitly set up an automated workflow.

2. **File everything useful.** If a Q&A answer, slide deck, or figure is worth generating, it's worth saving. Saved outputs can be referenced in future queries.

3. **Prefer depth over breadth.** A well-written article on one concept is more valuable than a shallow overview of ten.

4. **Index files are first-class citizens.** Keep `index.md` files accurate — they're the map of the entire knowledge base.

5. **Admit what you don't know.** If the wiki doesn't cover something, say so. Don't hallucinate. Suggest what raw material to add or what question to research next.

6. **Suggest before doing.** For major reorganizations (merging articles, splitting topics), describe what you plan to do and get confirmation before writing files.
