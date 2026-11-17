# magpie-rea-updater

A [Magpie](https://github.com/yetone/magpie) plugin that keeps the global npm
package `rea-agents` up to date for every agent.

It checks on a timer (default 6h) and when the Magpie window opens, and installs
automatically when no `rea` process is running.

## Install

```sh
magpie plugin add github:wangjianjq/magpie-rea-updater
```

## What it gives you

- **Page** "rea Updates" (rea 更新) — version, last check, manual check, log
- **Panel** `rea-agents` in the Agents slot — same state next to your agents

## Options

```json
{ "intervalHours": 6 }
```

Set through Magpie's plugin options.

## Files

| File | Purpose |
|---|---|
| `index.mjs` | Magpie plugin entry: registers the page and the panel |
| `rea-update-lib.mjs` | Update logic: version check, lock, running-guard, npm install |
| `page/` | The standalone page |
| `panel/` | The Agents-slot panel |

`rea-update-lib.mjs` keeps `rea-update.lock` and `rea-update-state.json` beside
itself at runtime; both are gitignored.

## Notes

This was originally a local folder plugin whose `index.mjs` imported
`../rea-update-lib.mjs`. Here the library sits beside `index.mjs`, so the import
is `./rea-update-lib.mjs` and the repo installs as one self-contained package.