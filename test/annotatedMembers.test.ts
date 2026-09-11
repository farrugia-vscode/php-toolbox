import { describe, expect, mock, test } from 'bun:test';
import * as vscodeStub from './vscodeStub';

const files = new Map<string, string>([
  [
    'file:///p/app/Models/Customer.php',
    `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

final class Customer extends Model
{
    public function notify(string $message): void
    {
    }
}
`,
  ],
  [
    'file:///p/app/Models/Order.php',
    `<?php

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\BelongsTo;

/**
 * @property-read Customer $customer
 *
 * @mixin IdeHelperOrder
 */
#[Fillable(['total'])]
final class Order extends Model
{
    public function customer(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }

    public function owner(): BelongsTo
    {
        return $this->belongsTo(Customer::class);
    }
}
`,
  ],
  [
    'file:///p/helpers/_ide_helper_models.php',
    `<?php

namespace App\\Models{
/**
 * @property int $id
 * @property-read Customer $owner
 * @method static \\Illuminate\\Database\\Eloquent\\Builder<static>|Order query()
 * @method static Order|null first()
 * @method touch()
 */
class IdeHelperOrder {}
}
`,
  ],
  [
    'file:///p/app/Handlers/PlaceOrder.php',
    `<?php

namespace App\\Handlers;

use App\\Models\\Order;

final class PlaceOrder
{
    public function execute(Order $order): void
    {
        $order->customer->notify('placed');
        $order->owner->notify('owned');
        $owner = $order->owner;
        $owner->notify('assigned');
        Order::query()->first()->customer->notify('latest');
        $order->touch()->notify('never');
        $order->shipment->notify('unknown');
    }
}
`,
  ],
]);

mock.module('vscode', () => vscodeStub);
mock.module('../src/workspaceIndex', () => ({
  getIndex: async () => files,
  onDidChangeFile: () => {},
  warmIndex: () => {},
}));

const { findMemberSites } = await import('../src/refactor/callSites');

const notify = { kind: 'method' as const, name: 'notify', className: 'App\\Models\\Customer' };

const lineOf = (site: { file: { text: string }; nameStart: number }) =>
  site.file.text.slice(site.file.text.lastIndexOf('\n', site.nameStart) + 1, site.file.text.indexOf('\n', site.nameStart)).trim();

describe('a member reached through what a docblock declares', () => {
  test('is typed by the @property of the class or its @mixin, read or assigned, over a relation method of the same name', async () => {
    const search = await findMemberSites(notify);

    expect(search.sites.map(lineOf)).toEqual([
      "$order->customer->notify('placed');",
      "$order->owner->notify('owned');",
      "$owner->notify('assigned');",
      "Order::query()->first()->customer->notify('latest');",
    ]);
  });

  test('reports a @method without a type as unknown, and says nothing of a member no tag names', async () => {
    const search = await findMemberSites(notify);

    expect(search.unresolved.map(lineOf)).toEqual(["$order->touch()->notify('never');"]);
    expect(search.sites.map(lineOf)).not.toContain("$order->shipment->notify('unknown');");
  });
});
