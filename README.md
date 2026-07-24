# PHP Toolbox

Navigation and refactoring for PHP projects, filling the gaps the built-in commands leave —
the PhpStorm habits, on `Alt+Enter`.

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

### Refactorings, on `Alt+Enter`

Every refactoring below is offered as a code action where it applies, so the way in is
always the same: put the cursor (or the selection) on the code, press `Alt+Enter`, pick.
They are in the command palette too, under **PHP:**.

| Refactoring             | Offered when                                     | What it does                                                                                  |
|-------------------------|--------------------------------------------------|-----------------------------------------------------------------------------------------------|
| Extract method          | statements selected in a method                  | moves them into a private method; reads become parameters, values the rest of the method still needs are returned |
| Extract variable        | an expression selected                           | assigns it above the statement, optionally replacing every identical occurrence of the scope   |
| Extract constant        | an expression made of literals                   | adds a `private const` and replaces every identical occurrence in the class                    |
| Extract property        | an expression selected in a method               | adds a private property, initialised where the value used to be computed                       |
| Introduce parameter     | an expression that reads no local state          | turns it into a parameter and passes the old value at every call site                          |
| Inline variable         | a local variable assigned once                   | replaces its uses by the value and drops the assignment                                        |
| Inline method           | the cursor on a method name or on a call         | replaces every call by the body and removes the method                                         |
| Change signature        | the cursor on a method name or on a call         | reorders, renames, retypes, adds or removes parameters, and updates every call and override    |
| Pull member up          | the cursor on a member                           | moves it to the parent class or to a trait, imports included                                   |
| Push member down        | the cursor on a member                           | copies it into the classes that extend it, imports included                                    |
| Extract interface       | the cursor on a class declaration                | publishes the public methods as an interface next to the class, and implements it              |
| Rename member           | the cursor on a method, property or constant     | renames it everywhere, overrides and promoted constructor parameters included                  |
| Move method             | the cursor on a method name                      | moves it to another class, routing the calls through a property or the class name              |
| Safe delete             | the cursor on a member or a type                 | lists what still uses it before removing anything                                              |
| Find implementations    | the cursor on an abstract or interface method    | lists the classes that answer the call, and jumps to one                                       |
| Implement missing       | a class that implements or extends               | writes the methods the contracts ask for, signatures and imports copied                        |
| Generate constructor    | the cursor on a class declaration                | takes the chosen properties as parameters and assigns them                                     |

Smaller rewrites are offered the same way, and applied straight from the menu:

- invert an `if`, merge it with the one nested inside it, or split a `&&` condition into two
- turn a closure that only returns into an arrow function
- turn a concatenation into an interpolated string
- promote a constructor parameter to a property, dropping the declaration and the assignment
- add `declare(strict_types=1)`

The signature editor is one line, each parameter tagged with the slot it comes from:

```
#1 string $to, #2 string $subject, #3 int $retries = 3
```

Move the tags around to reorder, edit the name or the type in place, drop a `#n` to remove
the parameter, add an entry without a tag to introduce one — the tags are what tells the
arguments at each call site where to go.

Refactorings that cannot be done correctly are refused rather than approximated: a public
method that a subclass could override is not inlined, a selection that returns from the
middle of a method is not extracted, and calls whose receiver is only known at runtime are
listed for confirmation before anything is written.

## Limitations

- Inline method needs a body of one expression, a guard clause, or a call that is a statement of its own.
- Extract method refuses a selection that jumps out of a loop or yields.
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
