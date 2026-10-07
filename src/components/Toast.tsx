import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface ToastAction { label: string; run: () => void }
type Show = (message: string, action?: ToastAction) => void;

const Ctx = createContext<Show>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; action?: ToastAction; key: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback<Show>((message, action) => {
    clearTimeout(timer.current);
    setToast({ message, action, key: Date.now() });
    timer.current = setTimeout(() => setToast(null), action ? 3500 : 2200);
  }, []);

  return (
    <Ctx.Provider value={show}>
      {children}
      <div className={`toast${toast ? ' show' : ''}`} role="status" aria-live="polite">
        <span>{toast?.message}</span>
        {toast?.action && (
          <button
            onClick={() => {
              toast.action!.run();
              setToast(null);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
