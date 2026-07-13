# PHP Inherited Symbols

Go to symbol in a PHP file **including members inherited from parent classes and traits** — the way PHPStorm's "Go to Symbol" works, unlike the built-in VS Code command which only lists symbols declared in the current file.

## Usage

Run **PHP: Go to Symbol (incl. inherited)** from the command palette while editing a PHP file.

## Install (local dev)

```bash
git clone git@github.com:farrugia-vscode/php-inherited-symbols.git ~/www/vscode-extensions/php-inherited-symbols
cd ~/www/vscode-extensions/php-inherited-symbols
bun install
bun run build   # compiles TS → out/extension.js
ln -s ~/www/vscode-extensions/php-inherited-symbols ~/.vscode/extensions/php-inherited-symbols
```

Reload VS Code. Dev loop: `bun run watch` (rebuild on change), `bun run check` (type-check).

## License

MIT
