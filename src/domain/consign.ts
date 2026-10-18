import type { EventItem, Item, Owner } from '../db/types';

// 受託(ほかのサークルの本を預かって売る)を使っているか(Issue #22)。
// 使っていないあいだは、持ち主の欄・精算・受託手数料などを出さない

/** 受託元(自分以外の持ち主)が1人でもいるか。しまった受託元も数える(過去の記録を見るため) */
export const hasConsignors = (owners: Pick<Owner, 'is_self'>[]) => owners.some((o) => !o.is_self);

/** このイベントに受託品が出ていたか(外した品目も含む) */
export function eventHasConsignment(s: { allEventItems: Pick<EventItem, 'item_id'>[]; items: Pick<Item, 'id' | 'owner_id'>[]; owners: Pick<Owner, 'id' | 'is_self'>[] }): boolean {
  const ownerOf = new Map(s.items.map((i) => [i.id, i.owner_id]));
  const consignors = new Set(s.owners.filter((o) => !o.is_self).map((o) => o.id));
  return s.allEventItems.some((e) => consignors.has(ownerOf.get(e.item_id) ?? ''));
}
