# companion-module-autoprompter-server

A [Bitfocus Companion](https://bitfocus.io/companion) module for **AutoPrompter Server**, a prompter
system for live shows and broadcast. It talks to AutoPrompter over OSC (UDP) and exposes transport,
setlist navigation, songs and speeches, markers, overlays, ready light, timers and instant messages,
with feedback and variables for button states.

See [companion/HELP.md](companion/HELP.md) for setup and usage — that is also the help shown inside
Companion.

## Development

```sh
yarn install      # or npm install
yarn build        # packages the module with companion-module-build
```

To try it in Companion, point the Developer Modules Path at the folder containing this repository.

## Releasing

1. Bump `version` in `package.json` and in `companion/manifest.json` (same value, `major.minor.patch`).
2. Tag the commit as `vX.Y.Z` and push the tag.
3. Submit the tag from the [Bitfocus Developer Portal](https://developer.bitfocus.io) under
   *My Connections → AutoPrompter Server → Submit Version*.

## Licence

MIT — see [LICENSE](LICENSE). The licence covers this module only; AutoPrompter Server itself is
proprietary software.
