import { eventStyle, EVENT_TYPES } from "./chartData";

// A row under the slider with one marker per event (deploy, config change, restart).
// Hover a marker to read the details. Click it to rewind to that moment.
export default function EventMarkers({ events, first, last, onPick }) {
  if (!events.length || first == null || last == null) return null;
  const span = Math.max(1, last - first);

  return (
    <div className="mt-2">
      <div className="relative h-5 mx-2" data-testid="event-markers">
        {events.map((e) => {
          const pct = Math.min(100, Math.max(0, ((e.timestamp - first) / span) * 100));
          const { label, color } = eventStyle(e.event_type);
          // Keep the tooltip inside the card: left-aligned near the left edge, right-aligned near the right edge
          const side = pct < 20 ? "left-0" : pct > 80 ? "right-0" : "left-1/2 -translate-x-1/2";
          return (
            <div key={e.id} className="group absolute top-0" style={{ left: `${pct}%` }}>
              <button
                onClick={() => onPick(e.timestamp)}
                aria-label={`${label}: ${e.description ?? ""}`}
                className="-ml-1.5 mt-1 block h-3 w-3 rotate-45 cursor-pointer border border-slate-900"
                style={{ background: color }}
              />
              <div
                className={`pointer-events-none absolute top-5 z-20 hidden w-56 rounded-lg border border-slate-600 bg-slate-900 p-2 text-xs shadow-lg group-hover:block ${side}`}
              >
                <p className="font-semibold" style={{ color }}>
                  {label}
                </p>
                {e.description && <p className="text-slate-100">{e.description}</p>}
                <p className="text-slate-400">{new Date(e.timestamp).toLocaleString()}</p>
                {e.meta &&
                  Object.entries(e.meta).map(([k, v]) => (
                    <p key={k} className="text-slate-400 break-all">
                      {k}: <span className="text-slate-200">{String(v)}</span>
                    </p>
                  ))}
                <p className="mt-1 text-slate-500">Click to rewind to this moment</p>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 flex flex-wrap gap-x-3">
        {Object.entries(EVENT_TYPES).map(([type, { label, color }]) => (
          <span key={type}>
            <span className="inline-block h-2 w-2 rotate-45 mr-1" style={{ background: color }} />
            {label}
          </span>
        ))}
      </p>
    </div>
  );
}