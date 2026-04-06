# LLM Agents

## Summary
LLM agents use large language models to autonomously plan and execute multi-step tasks, combining reasoning, tool use, memory, and feedback loops.

## Key Points
- **Planning**: Chain-of-thought prompting, ReAct, Tree of Thoughts
- **Tool Use**: Code execution, web search, file system access, API calls
- **Memory**: Short-term (conversation context) and long-term (persistent storage)
- **Feedback**: Human feedback, self-critique, environment rewards

## Notable Architectures
- AutoGPT: Full autonomous agents with web browsing
- Devin: AI software engineer
- Coze / LangChain: Agent development frameworks
- MCP: Model Context Protocol for tool interoperability

## Open Problems
1. Reliability: Agents often fail mid-task in non-obvious ways
2. Cost: Running many tool calls is expensive
3. Evaluation: Hard to measure if an agent "really" solved the task
4. Safety: Autonomous agents can cause unintended side effects

## Related Concepts
- [[concepts/rag-and-context|RAG and Long Context]]

## Source References
- [[references/llm-agents|Building LLM Agents]] — Survey of LLM agent architectures

## Further Questions
- How do I evaluate whether an LLM agent has truly completed a task?
- What are the cost-effective patterns for building agents at scale?