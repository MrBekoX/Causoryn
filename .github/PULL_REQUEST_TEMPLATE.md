## Summary

<!-- Briefly describe what changed and why. Link any related issue (`Closes #...`). -->

## Verification

- [ ] Added or updated tests following TDD (RED → GREEN), without weakening existing assertions
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm run build:bundle --workspace packages/mcp-server` passes
- [ ] `npm run build:package --workspace packages/causoryn` passes
- [ ] `node packages/causoryn/scripts/verify-package-ready.mjs` passes
- [ ] `npm run lint` passes
- [ ] `npm run secret-scan` passes
- [ ] `npm test` passes

## Architectural & Security Checklist

- [ ] Zero LLM/embedding/model API dependencies introduced (`ADR-002`)
- [ ] Analyzed workspace remains strictly read-only (`ADR-008`)
- [ ] Git access remains read-only with `shell: false` (no `checkout`/`reset`/`clean`, zero shell interpolation)
- [ ] `stdout` emits only MCP JSON-RPC 2.0 traffic; diagnostic logs go to `stderr`
- [ ] No personal usernames, local machine paths, or secrets introduced
- [ ] Relevant documentation and `CHANGELOG.md` updated (if user-facing behavior changed)
