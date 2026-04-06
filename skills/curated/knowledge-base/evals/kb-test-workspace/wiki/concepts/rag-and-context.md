# RAG and Long Context

## Summary
Large Language Models can handle very long contexts (100K+ tokens), but Retrieval-Augmented Generation (RAG) remains relevant depending on use case tradeoffs.

## When Long Context Wins
- The information is deeply interconnected across the entire document
- You need the model to "see" the full picture (e.g., long codebases)
- The documents are too unstructured to retrieve cleanly
- You don't have a good retrieval system set up

## When RAG Wins
- You have a large corpus and only need to retrieve a small relevant subset
- Cost matters: long context is expensive
- Latency matters: retrieval + short context is faster
- The corpus grows continuously and you need to scale

## The Hybrid Approach
The best approach at medium scale (100-400K words) is a hybrid:
1. Maintain a well-structured wiki index
2. Let the LLM decide what to read based on the query
3. Use the wiki's own summaries and backlinks as a "memory" layer

## Key Insight
For personal knowledge bases at human scale (not enterprise), the bottleneck is rarely retrieval - it is the quality of the knowledge organization itself.

## Related Concepts
- [[concepts/llm-agents|LLM Agents]]

## Source References
- [[references/rag-vs-context|RAG vs Long Context]] — Comparison of retrieval and context approaches

## Further Questions
- What is the cost-performance tradeoff for hybrid approaches at different scales?