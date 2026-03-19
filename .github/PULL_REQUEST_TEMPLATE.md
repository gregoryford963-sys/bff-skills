## Skill Name
<!-- What is the skill called? Must match the name field in SKILL.md frontmatter -->

## Category
<!-- Check one -->
- [ ] Trading
- [ ] Yield
- [ ] Infrastructure
- [ ] Signals

## What it does
<!-- 2–3 sentences. What does this skill do and why does an agent need it? -->

## On-chain proof
<!-- Required. Link to mainnet tx or paste live command output. No proof = not reviewed. -->

## Does this integrate HODLMM?
- [ ] Yes — eligible for the +$1,000 sBTC bonus pool
- [ ] No

## Smoke test results
<!-- Paste output of all three commands below -->

**doctor**
```
bun run skills/your-skill-name/your-skill-name.ts doctor
```

**install-packs**
```
bun run skills/your-skill-name/your-skill-name.ts install-packs --pack all
```

**run**
```
bun run skills/your-skill-name/your-skill-name.ts run
```

## Frontmatter validation
<!-- Paste output of: bun run scripts/validate-frontmatter.ts -->

## Security notes
<!-- Any writes to chain? Fund movements? Mainnet-only behavior? Note it here. -->

## Known constraints or edge cases
<!-- Anything a reviewer should know before testing -->
