# AGENTS.md

Before changing this bot extension, read [Cortico extension contracts](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).

- Use a Cortico checkout at tag `v0.2.13` for framework checks. Match `cortico.api` to its printed contract version.
- After changing Persona tools, default Worlds, Memory or prompt templates, run `pnpm describe:extension <dir>` from that checkout. Commit the generated file and ship it through `cortico.describe` and `files`.
- Before publishing, select applicable tags from [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md), including notice and warning tags. Maintainer tags take precedence; withdrawing a published warning requires a maintainer request.
- Add a `## <version>` section to CHANGELOG.md and include it in the package. Declare npm `os` only for supported platform restrictions.
- Run the package tests, TypeScript checks and WebUI build, then `pnpm check:extension <dir>` from the target checkout. Check the packed file list for the entry, browser assets, self-description and changelog.
- Build browser assets in an isolated copy while a deployed bot uses this checkout. Use fake deployments and scripted models for verification.
- Stage explicit paths and make local Conventional Commits. Push, publish and submit maintainer requests only when the user asks.
- For tag changes, certification, superseding packages or appeals, follow the [index request format](https://github.com/Pal-AI-Lab/cortico-extensions#readme). Certification requires a maintainer review.
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

### AI slop checklist

Review UI copy, prompts, documentation, code comments, commit messages and reports to the
operator sentence by sentence.
Prefer deleting redundant prose. Preserve factual content in documentation; trace vague claims to
their implementation and state the actual behavior. Keep comments only when they explain facts
that cannot be inferred from the code.

- [ ] **Obvious information**: Remove common knowledge and instructions evident from the UI.
- [ ] **UI narration**: Remove descriptions of cards, groups, buttons and layout. Show state in
  status labels.
- [ ] **Long narratives**: Reduce "this happens here, so you can..." to the necessary behavior,
  condition or result.
- [ ] **Manufactured contrast**: Remove "not A but B", rhetorical turns introduced with dashes and
  emphasis that serve no actual distinction.
- [ ] **Jargon and metaphors**: Use ordinary words for concrete objects and actions. Define necessary
  terms before using them and follow the project's naming conventions.
- [ ] **Vague actions**: State what an operation changes and when it takes effect. Replace phrases
  such as "touches the disk" or "finishes up" with the actual behavior.
- [ ] **Hype and reassurance**: Remove praise for the implementation, subjective modifiers such as
  "quietly" or "reliably", and unsupported assurances such as "rest assured".
- [ ] **Incident history**: Remove accounts of incidents, fixes, defenses of old designs and
  precautionary lectures. Express constraints that still apply as current rules.
- [ ] **Layer boundaries**: Keep platform details in their World. Shared entry points do not describe
  the internal behavior of a particular World, Persona or bot.
- [ ] **Misplaced information**: Put information needed for operation in the UI, contracts at
  interfaces, architecture in modules or their documentation, and history in git.
- [ ] **Repeated explanations**: State each fact only where needed. Check duplicate copy and other
  language versions during cleanup.
- [ ] **Accuracy after editing**: Verify retained behavior, conditions, units and boundaries.
  Necessary consequences, error causes and recovery steps must remain accurate and specific.