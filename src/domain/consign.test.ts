import { describe, expect, it } from 'vitest';
import { eventHasConsignment, hasConsignors } from './consign';

describe('受託を使っているか(Issue #22)', () => {
  const self = { id: 'o-self', is_self: true };
  const other = { id: 'o-b', is_self: false };

  it('自分以外の持ち主がいるときだけ、受託を使っている', () => {
    expect(hasConsignors([self])).toBe(false);
    expect(hasConsignors([self, other])).toBe(true);
  });

  it('イベントに受託品が出ていたか(外した品目も含めて見る)', () => {
    const items = [{ id: 'a', owner_id: 'o-self' }, { id: 'b', owner_id: 'o-b' }];
    expect(eventHasConsignment({ allEventItems: [{ item_id: 'a' }], items, owners: [self, other] })).toBe(false);
    expect(eventHasConsignment({ allEventItems: [{ item_id: 'a' }, { item_id: 'b' }], items, owners: [self, other] })).toBe(true);
  });
});
