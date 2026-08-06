/** What a generated test file says, kept apart from finding out where it goes. */

export type TestStyle = 'pest' | 'phpunit';

export interface TestSkeleton {
  /** Class name of the test, unused by Pest, which has no class. */
  name: string;
  namespace: string;
  /** Fully qualified name of what is being tested. */
  subject: string;
  style: TestStyle;
  /** Base class of the test case, as a fully qualified name. */
  baseClass: string;
  /** The file being tested declares strict types, so its test does too. */
  isStrict: boolean;
}

function shortName(fqn: string): string {
  return fqn.split('\\').pop() ?? fqn;
}

/** The first test, left empty on purpose: what to assert is the one thing nobody can guess. */
function pestBody(subject: string): string[] {
  return [
    `it('', function (): void {`,
    `    $subject = new ${shortName(subject)}();`,
    '',
    '    expect($subject)->toBeInstanceOf(' + shortName(subject) + '::class);',
    '});',
  ];
}

function phpunitBody(skeleton: TestSkeleton, unit: string): string[] {
  const subject = shortName(skeleton.subject);

  return [
    `final class ${skeleton.name} extends ${shortName(skeleton.baseClass)}`,
    '{',
    `${unit}#[Test]`,
    `${unit}public function it_(): void`,
    `${unit}{`,
    `${unit}${unit}$subject = new ${subject}();`,
    '',
    `${unit}${unit}self::assertInstanceOf(${subject}::class, $subject);`,
    `${unit}}`,
    '}',
  ];
}

/**
 * The test file, in the style the project already uses.
 *
 * Pest files hold no class and no namespace — the framework binds the closure to a test case
 * of its own — so the two styles share nothing but their imports.
 */
export function testFileContents(skeleton: TestSkeleton, unit = '    '): string {
  const isPest = skeleton.style === 'pest';
  const imports = [skeleton.subject, ...(isPest ? [] : [skeleton.baseClass, 'PHPUnit\\Framework\\Attributes\\Test'])]
    // A class of the same namespace needs no import, and neither does a global one.
    .filter((fqn) => fqn.includes('\\') && fqn.split('\\').slice(0, -1).join('\\') !== skeleton.namespace)
    .sort()
    .map((fqn) => `use ${fqn};`);

  return [
    '<?php',
    '',
    ...(skeleton.isStrict ? ['declare(strict_types=1);', ''] : []),
    ...(isPest ? [] : [`namespace ${skeleton.namespace};`, '']),
    ...(imports.length > 0 ? [...imports, ''] : []),
    ...(isPest ? pestBody(skeleton.subject) : phpunitBody(skeleton, unit)),
    '',
  ].join('\n');
}
