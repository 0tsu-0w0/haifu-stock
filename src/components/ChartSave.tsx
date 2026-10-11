import { useState } from 'react';
import { saveChartImage } from '../lib/chartImage';
import { fileStamp } from '../lib/download';
import { useToast } from './Toast';

/** グラフを画像で保存するボタン(F-1109)。ボタンの入っている figure のグラフを保存する */
export function ChartSave({ name }: { name: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button" className="chart-save" disabled={busy} aria-label="グラフを画像で保存"
      onClick={async (e) => {
        const fig = e.currentTarget.closest('figure');
        if (!fig) return;
        setBusy(true);
        try {
          const how = await saveChartImage(fig, `${name.replace(/[\\/:*?"<>|\s]+/g, '_')}_${fileStamp()}.png`);
          if (how === 'downloaded') toast('グラフを画像で保存しました');
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>
      画像
    </button>
  );
}
