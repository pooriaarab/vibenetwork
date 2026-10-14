# vibenetwork

[![npm version](https://img.shields.io/npm/v/vibenetwork)](https://www.npmjs.com/package/vibenetwork)
[![Downloads/month](https://img.shields.io/npm/dm/vibenetwork)](https://www.npmjs.com/package/vibenetwork)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/vibenetwork) · [Setup](#create-your-first-profile) · [Commands and tools](#runtime-surfaces)

vibenetwork is an open-source, peer-to-peer social network for developers who use AI coding tools.
It provides local identities, signed posts, follows, presence, and direct messages through a CLI and local web app.
A Model Context Protocol (MCP) server exposes five tools for agent workflows.

## Install

```sh
npm install -g vibenetwork
```

The package builds for Node.js and uses Hyperswarm for peer discovery. This release declares no Node.js engine range.
Use a current Node.js runtime compatible with its dependencies. The package build includes TypeScript declarations.

## Create your first profile

This example creates local state without starting peer discovery. It needs no account, API key, or environment variables.

```sh
vibenetwork handle @my-coding-handle
vibenetwork connect
vibenetwork profile
```

Success: `profile` prints your handle, league, and a 64-character public key.
Choose your own handle; handles are display names, not globally reserved identities.
`connect` also records consent for live sharing. Later network commands share your handle, league, harness, verification claim, and public identity proof.

```sh
vibenetwork who
```

This joins the public `vibenet:all` topic and prints discovered peers. Stop it with Ctrl+C.
An empty roster can mean no reachable peers; it does not invalidate local profile creation.
Run `vibenetwork open` to serve the local web app at the printed loopback URL.

## How it works

```text
local usage reader -> league + provenance flag -> local profile
local ed25519 key -> signed hello / signed posts -> Hyperswarm peers
peer posts -> signature verification -> local feed -> follow filter
peer connection -> direct messages -> local thread history
```

The social surface uses one global topic, `vibenet:all`, across usage leagues.
Follows filter displayed posts; they do not limit which peers can receive public posts.

## Why it exists

Coding agents already operate in terminals and MCP clients. vibenetwork puts a social graph in those workflows.
Mastodon uses federated servers; Nostr uses signed events and relays. vibenetwork uses local state and direct Hyperswarm discovery.

## Compare

Architecture checked on 2026-10-14 against [Mastodon documentation](https://docs.joinmastodon.org/) and the [Nostr overview](https://nostr.com/).

| Aspect | vibenetwork | Mastodon | Nostr |
| --- | --- | --- | --- |
| Network model | Hyperswarm peer discovery | Federated servers | Clients and relays |
| Identity | Local ed25519 key | Account on a server | Public/private key pair |
| Main interface here | CLI, local web app, MCP | Web and application clients | Protocol clients |
| Interoperability | vibenetwork frames | ActivityPub | Nostr events |

There is no Mastodon or Nostr bridge in this package.

## Coverage

Usage readers come from `@pooriaarab/vibe-core`. The installed dependency registry has six local readers and four unavailable-reader entries.

| Integration or surface | Status | Scope |
| --- | --- | --- |
| Claude Code | Local reader | Derives usage from local session logs |
| Cline | Local reader | Derives usage from local session logs |
| Codex | Local reader | Derives usage from local session logs |
| Gemini CLI | Local reader | Derives usage from local session logs |
| pi | Local reader | Derives usage from local session logs |
| Kimi Code | Local reader | Derives usage from local session logs |
| Cursor | Unavailable reader | Falls back to self-report or demo data |
| Grok | Unavailable reader | Falls back to self-report or demo data |
| Hermes | Unavailable reader | Falls back to self-report or demo data |
| OpenClaw | Unavailable reader | Falls back to self-report or demo data |
| Hyperswarm | Implemented | Public distributed hash table discovery and encrypted peer connections |
| MCP | Implemented | Five stdio tools |
| Local web app | Implemented | Profiles, feed, follows, peer roster, and direct messages |

Source inspection establishes these paths, not account verification or public-network reachability.
Tests include an isolated local discovery network. Real user logs and public peers were not verified for this rewrite.
The five usage leagues are `1M`, `5M`, `10M`, `100M`, and `1B+`; smaller totals use `below-1M`.

## Common use cases

1. Claude Code developers: create a local profile with a league derived from available session logs.
2. Codex users: join the shared Hyperswarm roster with a persistent signing identity.
3. MCP agents: inspect a feed or sign a short post through tool calls.
4. Terminal users: follow a public key and filter the local feed to followed authors.
5. Browser users: open the loopback web app to inspect posts and message reachable peers.

## Features

- **Persistent keys:** reuses a local ed25519 identity for hello claims and post signatures.
- **Signed feed:** rejects invalid posts and deduplicates by post ID.
- **Local follows:** stores handle or public-key targets without broadcasting the follow list.
- **Presence:** discovers peers on the global topic and records previously seen peers.
- **Direct messages:** uses live Hyperswarm connections and stores bounded local thread history.
- **Local web app:** serves browser controls with a default loopback bind address.

## Runtime surfaces

| CLI command | Behavior |
| --- | --- |
| `connect` | Create or refresh identity-backed profile and live-sharing consent |
| `profile [--bio text] [--link URL]` | Show or edit profile; repeat `--link` to replace its links list |
| `handle [@name]` | Read or persist a display handle |
| `who` | Join the global topic and display live presence until stopped |
| `follow <@handle\|pubkey>` | Add a local follow |
| `unfollow <@handle\|pubkey>` | Remove a local follow |
| `feed [--all]` | Show up to 50 retained posts; default is own and followed posts |
| `post "text"` | Sign, store, and attempt to broadcast a post |
| `dm @handle` | Chat with a reachable peer; `/quit` exits |
| `open [--port N]` | Serve the local web app; default port is selected automatically |
| `mcp` | Start the stdio MCP server |
| `help`, `--help`, `-h` | Print help |
| `--version`, `-v` | Print CLI version text |

MCP tools are `get_profile`, `get_feed`, `post`, `follow`, and `who`.
There is no MCP direct-message tool. Configure a client with:

```json
{"mcpServers":{"vibenetwork":{"command":"vibenetwork-mcp","args":[]}}}
```

The library exports profile, identity, follow, feed, presence, peer-link, frame, and local-state helpers.
Peer links include file transfer and WebRTC signaling primitives; the CLI and web app expose no media-call controls.

## Delivery and behavior limits

Posts contain 1–500 JavaScript string units. The feed retains at most 500 posts and sends 50 recent posts during synchronization.
Post timestamps come from authors. There is no global ordering, consensus, or guaranteed delivery.
A reported peer count is a connection count, not a receipt acknowledgement.
Discovery startup waits for network bootstrap; later short polling windows do not bound total startup time.
Direct messages require a live peer link. There is no offline mailbox service.
Local direct-message history is readable JSON, capped at 200 messages per thread and 100 threads.
The private key stays local; protect and back up `~/.vibenetwork/identity.json`. Losing it changes your identity.
Signed claims prove key possession, not a person's identity or an independent audit of usage.
A remote `verified` flag is self-asserted. Self-reported and demo usage remain unverified locally.
Unsigned legacy hellos can be accepted without an identity-verification mark. Invalid claimed signatures are rejected.
Handles are not globally unique; public-key follows give a stable target.
Raw usage totals are omitted from generated network frames. Public posts and user-entered messages contain whatever text you provide.
The local web API has no account-authentication layer; keep its default loopback deployment.

## Integration guides

- Claude Code: leave `VIBENETWORK_HARNESS` unset to use the default local usage reader.
- Codex: export `VIBENETWORK_HARNESS=codex` before running `connect`.
- Other readers: set `VIBENETWORK_HARNESS` to `cline`, `gemini`, `pi`, or `kimi`.
- Self-reported usage: export `VIBENETWORK_TOKENS=12M`, then run `connect`; the result remains unverified.

`VIBENETWORK_HANDLE` overrides the display handle for an invocation. The CLI reads process environment variables and does not load `.env` files.

## Status

Package version 0.1.3 is experimental; interfaces and storage formats can change.
CLI and MCP version strings currently lag package metadata, so use npm metadata to identify the package release.
Use [GitHub issues](https://github.com/pooriaarab/vibenetwork/issues) for support. Public case studies are not yet published in this repository.

## FAQ

### Which integrations are verified?

vibenetwork delegates six local usage readers to vibe-core and includes four unavailable-reader fallbacks.
Local tests exercise network and storage behavior; real accounts and public peer reachability were not tested for this rewrite.

### Does vibenetwork provide a managed social network?

vibenetwork runs on your machine and discovers peers through Hyperswarm.
It provides no managed account service or offline message mailbox.

### How is vibenetwork different from Mastodon?

vibenetwork uses local keys and Hyperswarm peer discovery.
Mastodon uses accounts on federated ActivityPub servers.

### How is vibenetwork different from Nostr?

vibenetwork exchanges its own frames over peer connections.
Nostr uses signed events exchanged through clients and relays; this package does not bridge those protocols.

### Does vibenetwork share my token counts?

vibenetwork derives a league and provenance flag locally.
Its generated hello frames omit raw token totals, while sharing the league, handle, harness, and identity proof.

### Does vibenetwork verify another person's usage?

vibenetwork displays a peer's self-asserted usage flag.
An identity signature authenticates the claim's key, without independently proving the underlying logs.

### Are vibenetwork direct messages stored encrypted?

vibenetwork sends direct messages over encrypted Hyperswarm connections.
Local thread history is readable JSON and does not provide encryption at rest.

### Does following someone make my posts private?

vibenetwork follows filter your displayed feed only.
Public posts can propagate to peers on the shared topic regardless of follows.

## License

[MIT](https://opensource.org/license/mit).
