# Lily

---

Custom document-drafting toolset for Carelaw Colorado, an estate planning law firm.

Lily streamlines the process of filling out templated Word documents (.docx) for client engagements. Users select a working directory (typically a client folder), choose a template, and fill in variables—Lily handles copying, previewing, and saving the completed document.

## Stack
- **Runtime / Package Manager:** Bun
- **Desktop Framework:** Tauri 2 (Rust backend)
- **Frontend:** React + TypeScript
- **Styling:** Tailwind CSS + daisyUI

## Workflow
1. Select a working directory (client folder)
2. Choose a template document from the configured templates folder
3. A copy of the template is placed in the working directory
4. Fill in template variables (e.g. `{Client First Name}`) via the sidebar form
5. Preview updates live as variables are filled in
6. Save and close—the completed .docx is ready for further editing in any word processor

## Development

```bash
# Install dependencies
bun install

# Run in development mode
make dev

# Build for production
make build
```
