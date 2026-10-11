import type { PaymentMethod } from '../db/types';
import { PAYMENT_LABEL } from '../domain/payment';

/** 支払い方法を選ぶ(#15)。この端末で現金しか使わない設定なら、何も出さない */
export function PayMethodChips({ methods, value, onChange }: { methods: PaymentMethod[]; value: PaymentMethod; onChange: (m: PaymentMethod) => void }) {
  if (methods.length <= 1) return null;
  return (
    <div className="chips pay-methods" role="radiogroup" aria-label="支払い方法">
      {methods.map((m) => (
        <button key={m} type="button" className="chip" role="radio" aria-checked={value === m} aria-pressed={value === m} onClick={() => onChange(m)}>
          {PAYMENT_LABEL[m]}
        </button>
      ))}
    </div>
  );
}
