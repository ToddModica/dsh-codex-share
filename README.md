# dsh-codex-share

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that makes Codex the single source of truth for skills and MCP servers.

Install a skill once, in Codex. Add an MCP server once, in Codex. DSH picks both up at startup — no copies, no symlinks, no hardlinks, nothing to keep in sync.

Because nothing is linked or duplicated, the same DSH profile keeps working after you sync it to another machine (macOS or Windows): every machine just re-reads its own local Codex install.

## What it shares

| Codex | DSH |
| --- | --- |
| Skills in `$CODEX_HOME/skills` | listed by the `codex` skill provider |
| Skills bundled with enabled Codex plugins | same provider, in marketplace order |
| MCP servers in `codex mcp list` | registered with DSH's MCP manager |
| MCP servers declared by plugin manifests (`.mcp.json`, `codex.mcp.json`) | used when the Codex CLI is not installed |

Codex-only tooling is skipped by default: `codex_app`, `computer-use`, `cua_repl`, `node_repl` and `itasca-mcp`. See [Configuration](#configuration) to change that.

## Install

```sh
dsh plugin install github:ToddModica/dsh-codex-share
```

Then restart DSH (`dsh web`) so the bundle is loaded. The plugin adds the Codex skill provider and the Codex MCP servers to the active profile; it does not write into your Codex install.

## Configuration

The bundle is configured in your profile's `cordis.patch.yml` (the row `id: codex-share`):

| Key | Default | Meaning |
| --- | --- | --- |
| `codexHome` | `''` | Codex home. Empty = `$CODEX_HOME`, else `~/.codex` (`%USERPROFILE%\.codex` on Windows). |
| `codexBin` | `''` | Codex executable. Empty = search `$CODEX_BIN`, then PATH and the usual install locations. |
| `excludeServers` | `codex_app`, `computer-use`, `cua_repl`, `node_repl`, `itasca-mcp` | MCP servers never shared. |
| `includeServers` | `[]` | When non-empty, share only these servers (ignores `excludeServers`). |
| `skillDirs` | `[]` | Extra skill directories, appended after the Codex roots. |

A server Codex has disabled (`enabled = false`) is never shared.

## How MCP servers are mapped

DSH's MCP client scrubs the parent environment, so everything a server needs is passed explicitly:

- `type = "stdio"` — `command`, `args`, `cwd`, `env` are carried over; `env_vars` names are resolved against the environment DSH itself runs in. A relative launcher such as `./mcp/launch` is resolved against its absolute `cwd`.
- `type = "streamable_http"` / `"http"` — `url` and `http_headers` are carried over. `bearer_token_env_var` becomes `Authorization: Bearer ${credential:NAME}` and every `env_http_headers` entry becomes `${credential:NAME}`, so DSH resolves the secret from its own credential store instead of inheriting Codex's environment.
- `startup_timeout_sec` / `tool_timeout_sec` become `startupTimeoutMs` / `toolCallTimeoutMs`.

### Credentials

Header templates are resolved by DSH's credential provider, which reads `~/.dsh/.credentials.yaml`, `$DSH_HOME/.env` and the project `.env` (in that precedence). If a secret is missing, the server simply stays down — DSH still boots. Configure the secret in DSH Settings → Credentials, or put e.g. `ANYSEARCH_API_KEY=...` in `~/.dsh/.env`.

Codex's own secrets are *not* copied into DSH; the two harnesses each read their own store.

## How skills are mapped

Skill roots, in priority order:

1. `$CODEX_HOME/skills`
2. `skills/` (or the manifest's `skills` path) of every enabled Codex plugin, sorted by marketplace/plugin
3. `$DSH_HOME/codex-share/skills` — an optional snapshot for machines with no Codex install
4. `skillDirs` from the bundle config

The first root that claims a skill name wins; later duplicates are logged. Discovery is one level deep, exactly like DSH: `root/<skill>/SKILL.md` or `root/<skill>.md`. The provider reports `complete: false`, so a newly installed Codex plugin's skills appear on the next lookup without restarting DSH.

Frontmatter follows the DSH skill format: `name` (kebab-case) and `description` are required; `whenToUse`, `disable-model-invocation` and `user-invocable` are honoured. Codex skills already use this format, so they load unchanged.

## Windows notes

- `$CODEX_HOME` is `%USERPROFILE%\.codex`; the plugin also checks `%APPDATA%\npm` and `%LOCALAPPDATA%\Programs\codex` for `codex.cmd`.
- `.cmd` / `.bat` shims are executed through the shell so they resolve correctly.
- No paths are written into the repository, the profile, or the sync payload — everything is computed at startup on the machine that runs DSH.

## Development

```sh
npm test
```

Node 20+. The only runtime dependency is `js-yaml`, used for SKILL.md frontmatter.

## Limitations

- A Codex server whose launcher is relative *and* whose `cwd` is also relative cannot be mapped; it is skipped with a reason.
- Codex-only servers that depend on Codex's internal RPC are excluded by default and generally will not work in DSH even if you include them.
- Skills are read from disk on every lookup; edits made in Codex show up without a restart.

## License

MIT