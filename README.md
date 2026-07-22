# PHP Toolbox

Navigation and refactoring for PHP projects, filling the gaps the built-in commands leave.

## Features

### Rename a class, interface, trait or enum

**PHP: Rename class, interface or trait…** (`Shift+F6`) rewrites the declaration and every
mention of it across the workspace, then renames the file to match.

It resolves names the way PHP does — through imports, aliases, the current namespace and
fully qualified names — so `Status` in one namespace is never confused with `Status` in
another. Class names written as strings (`'App\Jobs\SendMail'`, a Laravel config, a
PHPStan annotation) are updated too.

### Move a class

**PHP: Move class…** (`Ctrl+Shift+F6`) opens the fully qualified name for
editing, so the namespace, the class name or both change in one step. It rewrites the
`namespace` line, updates every import, adds the imports files now need, and moves the
file to the directory composer's `psr-4` map points at.

Moving or renaming a PHP file from the explorer does the same thing automatically: the
namespace and every reference follow the file.

### Go to symbol, including inherited members

**PHP: Go to Symbol (including inherited)** lists the members of the class under the
cursor together with everything it inherits — parents, interfaces, traits, `@mixin`
targets and docblock `@property`/`@method` declarations — grouped by where they come from.

### Find usages

**PHP: Find usages**, also offered on a declaration line under `Ctrl+.` together with the
two refactorings, lists what the workspace does with a type, grouped by intent: implemented by, extended by, used as a
trait, instantiated, injected, accessed statically.

## Limitations

- Method and property renames are not supported yet; only types.
- An import inside a `use A\{B, C};` group is left alone when the move takes the class out
  of the shared prefix. Those files are reported so they can be fixed by hand.

## Install (local dev)

```bash
git clone git@github.com:farrugia-vscode/php-toolbox.git ~/www/vscode-extensions/php-toolbox
cd ~/www/vscode-extensions/php-toolbox
bun install
bun run build   # compiles TS → out/extension.js
ln -s ~/www/vscode-extensions/php-toolbox ~/.vscode/extensions/php-toolbox
```

Reload VS Code. Dev loop: `bun run watch` (rebuild on change), `bun run check`
(type-check), `bun test` (rename engine).

## License

MIT
