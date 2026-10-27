"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/** Fires a synthetic PayPal webhook through the real pipeline (demo/dev only). */
export function SimulateButton({
  paypalSubscriptionId,
  eventType,
  label,
}: {
  paypalSubscriptionId: string;
  eventType: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function fire() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/demo/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paypalSubscriptionId, eventType }),
      });
      const data = await res.json();
      setResult(data.offerUrl ? "offer ready" : (data.agentStatus ?? data.error ?? "done"));
      startTransition(() => router.refresh());
    } catch (err) {
      setResult(`error: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={fire}
        disabled={busy || pending}
        className="rounded-md border border-slate-700 px-2 py-1 text-xs font-medium text-slate-300 hover:border-blue-500 hover:text-white disabled:opacity-50"
      >
        {busy ? "..." : label}
      </button>
      {result && <span className="text-xs text-emerald-400">{result}</span>}
    </span>
  );
}
