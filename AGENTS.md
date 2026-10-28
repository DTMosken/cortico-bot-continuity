# AGENTS.md

Before changing this bot extension, read [Cortico extension contracts](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).

- Use the supported target Cortico checkout for framework checks. Match `cortico.api` to its printed contract version.
- After changing Persona tools, default Worlds, Memory or prompt templates, run `pnpm describe:extension <dir>` from that checkout. Commit the generated file and ship it through `cortico.describe` and `files`.
- Before publishing, select applicable tags from [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md), including notice and warning tags. Maintainer tags take precedence; withdrawing a published warning requires a maintainer request.
- Add a `## <version>` section to CHANGELOG.md and include it in the package. Declare npm `os` only for supported platform restrictions.
- Run the package tests, TypeScript checks and WebUI build, then `pnpm check:extension <dir>` from the target checkout. Check the packed file list for the entry, browser assets, self-description and changelog.
- Build browser assets in an isolated copy while a deployed bot uses this checkout. Use fake deployments and scripted models for verification.
- Stage explicit paths and make local Conventional Commits. Push, publish and submit maintainer requests only when the user asks.
- For tag changes, certification, superseding packages or appeals, follow the [index request format](https://github.com/Pal-AI-Lab/cortico-extensions#readme). Certification requires a maintainer review.
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
