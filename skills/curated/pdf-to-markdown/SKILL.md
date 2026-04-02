---
name: pdf-to-markdown
description: Convert PDF documents into Markdown and send the resulting .md file back to the chat. Use this skill when the user asks to read, extract, convert,整理, or summarize a PDF file and wants the converted Markdown file returned.
---

# PDF To Markdown

Use this skill only when the current group has the MarkItDown MCP capability available. If the corresponding MCP tool is unavailable, tell the user the conversion capability is not enabled for this group.

## When to use

Use this skill when the user asks for any of the following:

- Convert a PDF to Markdown
- Extract the text or structure from a PDF into `.md`
- Read a PDF and send back a Markdown file
- Reformat a PDF into editable Markdown before further processing

## Required workflow

1. Identify the local PDF file path from the conversation context.
   Prefer the `可读路径:` line when it is present.

2. Build a `file://` URI for that local PDF path.

3. Call the MCP tool:

```text
mcp__markitdown__convert_to_markdown
```

with the PDF `file://` URI.

4. Save the Markdown result into the current group working directory under:

```text
./.generated/documents/<original-name>.md
```

5. If the user asked you to send the Markdown file back, use `send_message` with a local Markdown file link:

```md
[converted-name.md](./.generated/documents/converted-name.md)
```

This will be sent back as a file attachment through the existing file sending pipeline.

## Rules

- Do not pretend the conversion succeeded if the MCP tool failed.
- Do not paste a huge Markdown body directly into chat unless the user explicitly asks for inline content.
- Prefer returning the `.md` file itself.
- Keep the converted output inside `./.generated/documents/`.
- If a same-named file already exists, overwrite it only when that is clearly intended; otherwise choose a distinct filename.
