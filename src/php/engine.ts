import { Engine } from 'php-parser';

const engine = new Engine({
  parser: { extractDoc: false, suppressErrors: true, php7: true },
  ast: { withPositions: true },
});

/** The syntax tree of a PHP file, or null when it is too broken to parse. */
export function parseAst(text: string): any | null {
  try {
    return engine.parseCode(text, 'file.php');
  } catch {
    return null;
  }
}
