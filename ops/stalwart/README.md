# ops/stalwart

Two files, and **neither of them is mounted into the container**:

- `config.json.example` — a copy of the one file Stalwart keeps on disk, kept
  here for disaster recovery. See below.
- this README.

That is the whole directory. The `stalwart` service is described entirely by its
block in `docker-compose.prod.yml`; there is no configuration file to ship,
which is unusual enough for a mail server to be worth writing down.

Note this directory is **new** — it arrives with the mail phase 1 changeset, and
`git log -- ops/stalwart` is empty before it. Nothing was removed from here and
nothing stale is waiting on the homelab; the section below is about the product,
not about a file this folder lost.

## Why there is no config.toml

Stalwart `v0.16.19` — the tag pinned in `docker-compose.prod.yml` — **cannot
read TOML at all.** Read from the tag's own source
(`github.com/stalwartlabs/stalwart` at ref `v0.16.19`):

- `crates/store/src/registry/local.rs:71-80` parses the file named by
  `--config` with `serde_json::from_str::<DataStore>(&contents)`. JSON, one
  object, nothing else.
- `Dockerfile:45-46` is `ENTRYPOINT ["/usr/local/bin/stalwart"]` /
  `CMD ["--config", "/etc/stalwart/config.json"]`. There is no entrypoint
  script, so there is no `--init`, and the 0.11 trap ("mounting a config file
  skips init and leaves no way in") does not exist in this shape any more.
- `grep -rni toml` over `crates/**/*.rs` returns nothing, and no `Cargo.toml`
  in the workspace depends on a `toml` crate.

Everything that used to live in `config.toml` — listeners, stores, directory,
authentication, tracing — now lives in the **registry**, i.e. inside the data
store itself, and is edited through the WebUI (`/admin`) or the JMAP management
API. See `docs/deploy.md` §8.

## What `config.json.example` is

It is a **copy of the one file Stalwart still keeps on disk**: the DataStore
object, which says nothing more than "the registry and the mail data live in a
RocksDB at this path". Stalwart writes it itself at the end of the setup wizard
(`crates/store/src/registry/local.rs:91-105`, `write_data_store`).

It is here for two reasons, neither of which is "the deploy mounts it":

1. **Disaster recovery.** If `/etc/stalwart` is lost but `/var/lib/stalwart`
   survives, Stalwart starts in bootstrap mode and offers to build a *new*
   store beside the perfectly good one. Dropping this file back in place is the
   whole fix.
2. **A way in if the WebUI cannot be fetched.** `/admin` is not baked into the
   image; it is downloaded at first start from
   `https://github.com/stalwartlabs/webui/releases/latest/download/webui.zip`
   (`crates/common/src/manager/defaults.rs:58-76`). With no outbound internet
   there is no wizard, and `stalwart-cli` is no longer in the image either
   (upstream discussion #3013). Writing this file by hand skips the wizard: the
   server then starts in normal mode, inserts its safe defaults, and
   `STALWART_RECOVERY_ADMIN` is still honoured as the login
   (`crates/common/src/auth/authentication.rs:85-89`).

If it is ever used that way, copy it — do not mount it. Stalwart owns that path
and may rewrite it.

**Nothing in this file has been measured.** No Stalwart has run in this project.
Every claim above cites source at ref `v0.16.19`; `docs/deploy.md` §8.9 lists
what to confirm on the first start.
