import { describe, expect, test } from 'bun:test';
import { testFileContents } from '../src/refactor/testSkeleton';

const SUBJECT = {
  name: 'InvoicerTest',
  namespace: 'Tests\\Unit\\Billing',
  subject: 'App\\Billing\\Invoicer',
  baseClass: 'Tests\\TestCase',
  isStrict: true,
} as const;

describe('a PHPUnit test file', () => {
  test('declares the namespace, imports what it names and extends the project test case', () => {
    expect(testFileContents({ ...SUBJECT, style: 'phpunit' })).toBe(`<?php

declare(strict_types=1);

namespace Tests\\Unit\\Billing;

use App\\Billing\\Invoicer;
use PHPUnit\\Framework\\Attributes\\Test;
use Tests\\TestCase;

final class InvoicerTest extends TestCase
{
    #[Test]
    public function it_(): void
    {
        $subject = new Invoicer();

        self::assertInstanceOf(Invoicer::class, $subject);
    }
}
`);
  });

  test('leaves out strict types when the class under test does not declare them', () => {
    expect(testFileContents({ ...SUBJECT, style: 'phpunit', isStrict: false })).not.toContain('declare(');
  });
});

describe('a Pest test file', () => {
  test('holds no class and no namespace', () => {
    const contents = testFileContents({ ...SUBJECT, style: 'pest' });

    expect(contents).toBe(`<?php

declare(strict_types=1);

use App\\Billing\\Invoicer;

it('', function (): void {
    $subject = new Invoicer();

    expect($subject)->toBeInstanceOf(Invoicer::class);
});
`);
    expect(contents).not.toContain('namespace');
    expect(contents).not.toContain('PHPUnit');
  });
});
