# Figma Local Bridge

[Русская инструкция](README.ru.md) · [Agent instructions](AGENTS.md) · [Security](SECURITY.md)

An unofficial, local MCP server and Figma development plugin for reading and editing a Figma Design file. It creates **editable layers**, not flattened screenshots, using the Figma Plugin API. No Figma personal access token, OpenAI API key, hosted bridge, or cloud Figma MCP is required by this project. Your AI client's authentication, usage limits and Figma permissions still apply.

## Requirements

- Node.js **22 or newer**, with npm.
- Figma Desktop with access to a Design file you can edit and permission to run development plugins.
- An MCP client that can launch a **local stdio server** on the same machine, such as Codex. Other clients need equivalent stdio configuration; their individual UIs are not tested here.
- Internet for installing npm dependencies and normal Figma/client operation. The bridge itself listens only on loopback.

This is not a remote HTTP MCP endpoint, not an official Figma/OpenAI integration, and not a way around either product's access restrictions. Figma and the MCP server must run on the same computer; a remote container or browser-only chat cannot reach the desktop plugin by adding this URL.

## Quick start

### 1. Install and build locally

Clone this repository, or download its **source** ZIP, then open a terminal in its folder:

```sh
cd figma-local-bridge
npm ci
npm run check
npm run build
```

The build prints the absolute path to `dist/manifest.json`. It also creates a random pairing token in `.local/settings.json` and embeds it in your local plugin UI. **Do not share `.local/` or `dist/`: every user must build their own plugin.**

### 2. Connect your MCP client

For **Codex CLI**, replace the placeholder with the real absolute path:

```sh
codex mcp add figma_local_bridge -- node "/absolute/path/figma-local-bridge/server.mjs"
codex mcp list
```

Alternatively, add this to Codex's `~/.codex/config.toml`:

```toml
[mcp_servers.figma_local_bridge]
command = "node"
args = ["/absolute/path/figma-local-bridge/server.mjs"]
```

On Windows a valid TOML path is `'C:\tools\figma-local-bridge\server.mjs'`. For any stdio-capable MCP client, the equivalent generic configuration is:

```json
{
  "mcpServers": {
    "figma_local_bridge": {
      "command": "node",
      "args": ["/absolute/path/figma-local-bridge/server.mjs"]
    }
  }
}
```

Merge the server entry into your client's existing configuration; do not overwrite other servers. Use your client's documented location/schema. If a desktop client cannot find `node`, replace `command` with its absolute executable path (`command -v node` on macOS/Linux, `(Get-Command node).Source` in PowerShell). Restart the MCP connection/client after configuration. You do not need a fixed working directory.

Codex configuration follows [official OpenAI documentation](https://developers.openai.com/codex/mcp/). This repository does not install or change your client configuration automatically.

### 3. Import and run the Figma plugin

1. Open your editable file in **Figma Desktop**.
2. Choose **Plugins → Development → Import plugin from manifest…** and select the generated `dist/manifest.json`.
3. Run **Plugins → Development → Figma Local Bridge**.
4. Keep the plugin window open. It should say **Connected to local bridge** after the MCP client or `npm run status` starts the bridge.

If Figma requests a plugin ID, create a development plugin using Figma's **Create new plugin** flow. Copy its assigned numeric `id` into your private `.local/settings.json` as a string named `pluginId`, keeping `port` and `token` intact, then run `npm run build` again. Do not invent or copy another project's ID. See the [Figma manifest documentation](https://developers.figma.com/docs/plugins/manifest/).

Only one plugin/file can be connected at a time. To change files, close the old plugin window and run it in the new file. Each plugin run produces a new session `documentId`; it is **not** a permanent Figma file key.

### 4. Give your agent the rules

Before design work, ask your agent:

> Read `/absolute/path/figma-local-bridge/AGENTS.md`, then use the `figma_local_bridge` MCP tools. Check status and read the document first. Tell me which file is connected. Do not modify anything until the task requires it.

`AGENTS.md` is automatically discoverable only when your agent's project rules include this repository. If you work in another folder, explicitly supply the file or copy the **Using the MCP tools** section into that project's agent instructions.

## Tools

Client namespaces may add a prefix; the stable tool names are:

| Tool | Purpose |
| --- | --- |
| `figma_status` | Connection status; does not require an open plugin |
| `figma_document` | Pages, selection, bounded tree and current session `documentId` |
| `figma_fonts` | Available fonts, optionally filtered by family |
| `figma_create_nodes` | Editable frames, text, shapes, SVG, image fills, components and instances |
| `figma_update_nodes` | Change existing layers; partial changes are possible on error |
| `figma_export_node` | PNG preview, maximum edge 4096 px |
| `figma_focus` | Select layers and focus the editor viewport |
| `figma_connect_screens` | Click navigation to a frame; replaces the source's existing reactions |
| `figma_move_frames_to_page` | Move exact frames to the current page while preserving canvas position |
| `figma_delete_nodes` | Remove exact nodes; use only with task authorization |

Create/update tools take JSON **strings** in `nodesJson`/`updatesJson`. The CLI uses ordinary JSON arrays named `nodes`/`updates` instead. Read the live tool schemas for all supported properties.

Document reads report mixed text `fontName` and `fontSize` as the JSON string `"mixed"`. Exact node handles returned by bounded reads are remembered for the current plugin session, including instance descendants. After reopening the plugin, read the relevant parent again before using its child IDs.

Supported basics: auto-layout, padding, sizing, colors, typography, images, local components/instances and prototype navigation. Not implemented: arbitrary JavaScript evaluation, a full Figma API wrapper, variables, component variant sets, library publishing, remote component import, FigJam or Slides. Fonts must be available in the connected editor; prefer explicit font family/style after `figma_fonts`.

## CLI and examples

```sh
npm run status
node cli.mjs document
node cli.mjs fonts
```

`npm run status` and the MCP server automatically start a shared background bridge when needed. Default address: `127.0.0.1:3848`. `connected: false` means the server is healthy but the plugin is not connected yet. Never paste status output publicly without removing file names/session identifiers.

For a scratch file, copy [examples/card.json](examples/card.json), replace `REPLACE_WITH_DOCUMENT_ID` with the result of `document`, inspect existing bounds and choose clear `x`/`y` coordinates, then run:

```sh
node cli.mjs create_nodes examples/card.json
```

Copy the returned `keys.card` node ID into [examples/export.json](examples/export.json), update its `targetDocumentId`, then:

```sh
node cli.mjs export_node examples/export.json preview.png
```

Write preview files outside the repository or keep them untracked: they can contain private designs. The CLI exits non-zero on errors; JSON output may include `partial` or `possiblyChangedNodeIds`. Inspect before retrying.

To stop this copy's bridge:

```sh
npm run stop
```

Stop is authenticated and refused while a command is in progress. If already stopped it exits non-zero without starting another bridge. Closing only the Figma plugin revokes access to its file, but the shared local process can remain running. Starting a new MCP connection or running `npm run status` can start it again. An existing MCP connection does not automatically restart a stopped bridge; reconnect the MCP client or run `npm run status` to recover. Disable the client entry first if you want it to stay off.

For foreground diagnostics, stop the background bridge first, then run `npm run bridge` and use Ctrl+C to stop it.

## Configuration and troubleshooting

`.local/settings.json` is private local state, not a file to commit. Optional `FIGMA_BRIDGE_STATE_DIR` selects another private state directory; build and runtime must use the **same** directory. It is mainly useful for isolated testing or a read-only checkout. No cloud credentials are needed.

| Symptom | What to do |
| --- | --- |
| MCP tools missing | Check the absolute server/Node paths; restart the client connection; run `npm run status`. |
| Waiting for local bridge | Start the MCP connection or run `npm run status`; keep the Figma plugin open. |
| Port occupied / wrong service / HTTP 401 | Do not stop unrelated processes. Use another port: stop this bridge, change only `port` in its `.local/settings.json`, rebuild and restart the client/plugin. |
| Invalid pairing | Ensure server and plugin came from the same checkout/state directory. Rebuild, close the old plugin and reopen it. |
| Another plugin connected | Close the previous file's plugin before connecting another. |
| Target document changed | Read `figma_document` again; use its new `documentId`. |
| Missing font | Use `figma_fonts` to find an available exact family/style. |
| Command failed, but bridge connected | The plugin shows the exact command error separately from the connection status. A failed read does not imply a disconnected bridge. Failed writes may have partially applied: inspect the canvas before retrying. |
| Unable to establish connection to Figma after 10 seconds | A Figma API operation failed. Check `figma_status` before restarting the local bridge; it may still be connected. For a nested node, read its known parent first and use the exact returned child ID in the same plugin session. |
| Timeout / partial error | The design may already have changed. Inspect it before reconnecting or retrying; never blindly replay a write. |
| Bridge will not start | Read your private `.local/bridge.log`, redacting file/session data before sharing it. |

If a pairing token is exposed, stop/disable this MCP, replace the token in your private settings with a fresh 32-byte random hex value, rebuild, and reopen the plugin. Never weaken authentication or bind to `0.0.0.0` to fix connectivity.

## Development and sharing

```sh
npm ci
npm run check
npm run build
npm test
```

Tests exercise authenticated HTTP/WebSocket transport, a simulated plugin and a real MCP SDK stdio handshake. They do **not** prove every editor-side operation in real Figma. Smoke-test a scratch Design file after changing plugin code: read → create → update → export → remove only the test-created layers. Normal Figma Undo remains available; operations are not universally transactional.

GitHub Actions is configured for Node 22 on Linux, macOS and Windows; these runners will execute after publication. This is source-first distribution, not a published npm package (`private: true` prevents accidental npm publication).

Share the repository or a source archive, **not the working directory**. The Git and npm ignore rules exclude generated pairing data and plugin bundles. Never attach `.local/`, `dist/`, `.env`, logs, private design exports or `node_modules/` to a release. Each recipient runs `npm ci` and `npm run build` locally.

Licensed under [MIT](LICENSE). Dependency licenses remain their respective owners'.
