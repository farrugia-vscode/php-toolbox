import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

mock.module('vscode', () => vscodeStub);

const { parseFile } = await import('../src/php/parser');
const { conventionIssues, DEFAULT_CONTRACT_METHODS } = await import('../src/conventions/rules');

const OPTIONS = { contractMethods: DEFAULT_CONTRACT_METHODS };

function issuesOf(source: string) {
  return conventionIssues(source, parseFile(source), OPTIONS);
}

function rulesOf(source: string) {
  return issuesOf(source).map((issue) => issue.rule);
}

/** Applies the fix of the first issue matching the rule, so a test can read the result. */
function fixed(source: string, rule: string): string {
  const issue = issuesOf(source).find((candidate) => candidate.rule === rule);

  if (issue?.fix?.kind !== 'edits') {
    throw new Error(`No editing fix for ${rule}`);
  }

  return [...issue.fix.edits]
    .sort((first, second) => second.start - first.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
}

describe('boolean names', () => {
  test('reports a property that does not announce a boolean', () => {
    const source = `<?php

final class Order
{
    public bool $paid = false;
}
`;

    expect(rulesOf(source)).toEqual(['booleanPrefix']);
  });

  test('leaves a prefixed one alone', () => {
    const source = `<?php

final class Order
{
    public bool $isPaid = false;

    public function hasCoupon(): bool
    {
        return true;
    }
}
`;

    expect(rulesOf(source)).toEqual([]);
  });

  test('reports a promoted parameter and a method returning a boolean', () => {
    const source = `<?php

final readonly class Order
{
    public function __construct(private bool $paid) {}

    public function shippable(): bool
    {
        return $this->paid;
    }
}
`;

    expect(rulesOf(source)).toEqual(['booleanPrefix', 'booleanPrefix']);
  });
});

describe('action verbs', () => {
  test('reports a method named after a preposition', () => {
    const source = `<?php

final class Pricing
{
    public function toAmounts(): array
    {
        return [];
    }
}
`;

    const [issue] = issuesOf(source);

    expect(issue.rule).toBe('actionVerb');
    expect(issue.message).toContain('getAmounts()');
  });

  test('leaves a method the framework calls alone', () => {
    const source = `<?php

final class Pricing
{
    public function toArray(): array
    {
        return [];
    }
}
`;

    expect(rulesOf(source)).toEqual([]);
  });
});

describe('classes built by injection', () => {
  test('declares them final and readonly, dropping the repeated modifier', () => {
    const source = `<?php

class UserService
{
    public function __construct(private readonly UserRepository $repository) {}
}
`;

    expect(fixed(source, 'immutableService')).toBe(`<?php

final readonly class UserService
{
    public function __construct(private UserRepository $repository) {}
}
`);
  });

  test('leaves a class that already says so alone', () => {
    const source = `<?php

final readonly class UserService
{
    public function __construct(private UserRepository $repository) {}
}
`;

    expect(rulesOf(source)).toEqual([]);
  });

  test('asks only for final when a trait may bring a mutable property', () => {
    const source = `<?php

class SendMailJob
{
    use Queueable;

    public function __construct(private readonly Mailer $mailer) {}
}
`;

    const [issue] = issuesOf(source);

    expect(issue.message).toContain('declare it final.');
  });

  test('asks only for final when a property carries a default value', () => {
    const source = `<?php

final class HandlePaid
{
    public int $tries = 5;

    public function __construct(private readonly Recorder $recorder) {}
}
`;

    expect(rulesOf(source)).toEqual([]);
  });

  test('asks only for final when the class extends another', () => {
    const source = `<?php

class ShowStatusController extends Controller
{
    public function __construct(private readonly Reader $reader) {}
}
`;

    const [issue] = issuesOf(source);

    expect(issue.message).toContain('declare it final.');
  });

  test('leaves a method a framework calls by name alone', () => {
    const source = `<?php

final readonly class LoginRequest
{
    public function __construct(private Guard $guard) {}

    public function authorize(): bool
    {
        return true;
    }
}
`;

    expect(rulesOf(source)).toEqual([]);
  });

  test('leaves a class with no injected dependency alone', () => {
    const source = `<?php

class Formatter
{
    public function run(): void {}
}
`;

    expect(rulesOf(source)).toEqual([]);
  });
});

describe('braces', () => {
  test('wraps a body written on the line of its condition', () => {
    const source = `<?php

function ship(Order $order): void
{
    if (!$order->isPaid()) throw new UnpaidOrderException();
}
`;

    expect(fixed(source, 'braces')).toBe(`<?php

function ship(Order $order): void
{
    if (!$order->isPaid()) {
        throw new UnpaidOrderException();
    }
}
`);
  });

  test('leaves a body that already has braces alone', () => {
    const source = `<?php

function ship(Order $order): void
{
    if (!$order->isPaid()) {
        throw new UnpaidOrderException();
    }
}
`;

    expect(rulesOf(source)).toEqual([]);
  });
});

describe('em dashes', () => {
  test('replaces one written in a string', () => {
    const source = `<?php

$label = 'Paiement — en attente';
`;

    expect(fixed(source, 'emDash')).toBe(`<?php

$label = 'Paiement - en attente';
`);
  });

  test('leaves one written in a comment alone', () => {
    const source = `<?php

// Paiement — en attente
$label = 'Paiement en attente';
`;

    expect(rulesOf(source)).toEqual([]);
  });
});

describe('traits read by the parser', () => {
  test('lists the traits a class uses, resolved through its imports', () => {
    const parsed = parseFile(`<?php

namespace App\\Jobs;

use Illuminate\\Bus\\Queueable;

final class SendMailJob
{
    use Queueable;
    use SerializesModels;
}
`);

    expect(parsed.declarations[0].traits).toEqual([
      'Illuminate\\Bus\\Queueable',
      'App\\Jobs\\SerializesModels',
    ]);
  });
});
