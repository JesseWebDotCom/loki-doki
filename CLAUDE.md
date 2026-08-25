# MaiPai Home

The self-hosted family AI hub: backend (Bun + Hono), web frontend
(React + Vite), the MaiPai Desktop app (Electron, in `desktop/`), and pod
firmware.

Org standards apply and are auto-loaded from the parent directory CLAUDE.md
(source: [getmaipai/.github](https://github.com/getmaipai/.github)).

See [agents.md](./agents.md) for the tech stack, component hierarchy, and
coding conventions specific to this repo.

Upgrade shims for installs that predate the MaiPai rename (remove once the
fleet has migrated): legacy `LOKIDOKI_*` env vars are aliased to `MAIPAI_*`
at boot, the old backups folder auto-renames on first use, and the old
sandbox firewall table is cleared when the new one applies. Historical
literals that must stay verbatim: the companion migration table's old names
and phrases in `defaultCompanions.ts` (they match existing user data).
