import type { PaymentMethod, Txn } from '../db/types';

// 支払い方法(#15)。現金以外(コード決済・カードなど)で受け取った売上は、現金の数え合わせに入れない

export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'qr', 'card', 'other'];

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  cash: '現金', qr: 'コード決済', card: 'カード', other: 'その他',
};

/** 支払い方法のない記録(古い版の端末や、この機能の前の記録)は現金 */
export const methodOf = (t: Pick<Txn, 'payment_method'>): PaymentMethod => t.payment_method ?? 'cash';

export const isPaymentMethod = (v: unknown): v is PaymentMethod => typeof v === 'string' && (PAYMENT_METHODS as readonly string[]).includes(v);
