# LLM Agents: A Survey

LLM agents use large language models to autonomously plan and execute multi-step tasks. Key components:

## Core Components

**1. Planning / Reasoning**
- Chain-of-thought prompting
- ReAct (Reasoning + Acting)
- Tree of Thoughts for exploration

**2. Tool Use**
- Code execution
- Web search
- File system access
- API calls

**3. Memory**
- Short-term: conversation context
- Long-term: persistent storage of completed tasks, learned facts

**4. Feedback**
- Human feedback (preferred when available)
- Self-critique and reflection
- Environment rewards

## Notable Architectures

- **AutoGPT**: Full autonomous agents with web browsing
- **Devin**: AI software engineer (Claude dev)
- **Coze / LangChain**: Agent development frameworks
- **MCP**: Model Context Protocol for tool interoperability

## Open Problems

1. **Reliability**: Agents often fail mid-task in non-obvious ways
2. **Cost**: Running many tool calls is expensive
3. **Evaluation**: Hard to measure if an agent "really" solved the task
4. **Safety**: Autonomous agents can cause unintended side effects

## Resources

- OpenAI's "Building Effective Agents" guide (2024)
- Anthropic's "Clio" paper on agent monitoring
- Survey: "A Survey on Large Language Model based Autonomous Agents" (2024)
