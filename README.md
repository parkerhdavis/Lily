![Lily Icon](./resources/icons/128x128.png)
# Lily

Legal document drafting and client info management toolset, created custom for an estate-planning law firm.

Lily streamlines the process of gathering client information and using it to populate initial drafts of client documents derived from Word documents (.docx) templated with a custom syntax, which legal professionals can then polish and supervise to execution. Users select a working directory (typically a client folder), choose a template, and fill in variables; Lily handles copying, previewing, and saving the completed document, which can be edited like any normal Word document and re-opened at any time to adjust variables.

![Screenshot from v0.3.0 dev build 2026-03-25](./.github/assets/lily_screenshot_home.png)

*Screenshot from v0.3.0 dev build 2026-03-25*

## Stack
- **Runtime / Package Manager:** Bun
- **Desktop Framework:** Tauri 2 (Rust backend)
- **Frontend:** React + TypeScript
- **Styling:** Tailwind CSS + daisyUI



![Screenshot from v0.3.0 dev build 2026-03-25](./.github/assets/lily_screenshot_hpoa.png)

*Screenshot from v0.3.0 dev build 2026-03-25*

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
make setup

# Run in development mode
make dev

# Build for production
make build
```


## License

Covered under the GPL License, see [LICENSE](./LICENSE.md)

Beyond that, I only have one rule: **First, do no harm. Then, help where you can.**


## Financial Support

If you have some cash to spare and are inspired to share, that's very kind. Rather than sharing that kindness with me, I encourage you to share it with your charity of choice. 

Mine is the [GiveWell top charities fund](https://www.givewell.org/top-charities-fund) , which does excellent research to figure out which causes can save the most human lives for the money, and put their funds there.

Their grant to the [Against Malaria Foundation](https://www.againstmalaria.com) was shown to deliver outcomes at a cost of just $1,700 per life saved.

![GiveWell Logo](.github/assets/givewell_logo.png)
