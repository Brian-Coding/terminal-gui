# inferay

Command-line installer and launcher for Inferay.

```sh
npx inferay
```

The package is intentionally small. It does not contain the desktop app. It
resolves the right release asset, installs the app, launches an installed app,
and runs setup checks.

## Commands

```sh
inferay                 # install or launch Inferay
inferay .               # open the current folder
inferay install         # install or replace the latest release
inferay install --local ./build/stable-macos-arm64/inferay.app
inferay launch ~/code   # open a workspace
inferay doctor          # check user setup
inferay doctor --dev    # check contributor setup
inferay update          # replace Inferay with the latest release
inferay channel nightly # switch release channel
```

## Development

Contributors should work from the source repo:

```sh
bun install
bun run dev
```

Users should not need Bun or a source checkout.
