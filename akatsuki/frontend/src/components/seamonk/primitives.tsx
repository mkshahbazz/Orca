"use client";

/**
 * THE SEAMONK — shared console primitives.
 *
 * These are the only building blocks the pages use. They encode product
 * decisions rather than styling: a status is always a glyph *and* a word, a
 * reading is always visually separated from raw measurement, and every table
 * is sortable and keyboard reachable.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Tone } from "@/lib/seamonk/design";
import { Beacon, Check, Close, Info, Refresh, TrendDown, TrendUp, Warning } from "./icons";

/* ------------------------------------------------------------------- panels */

export function Panel({
  children,
  className = "",
  variant,
  as: Tag = "section",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  variant?: "plain" | "flush";
  as?: "section" | "aside" | "div" | "article";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={`sk-panel${variant ? ` sk-panel--${variant}` : ""} ${className}`.trim()}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function PanelHead({
  icon,
  title,
  hint,
  actions,
  id,
  level = 2,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  id?: string;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="sk-panel-head">
      <Heading className="sk-panel-title" id={id}>
        {icon}
        <span>{title}</span>
      </Heading>
      {hint ? <span className="sk-panel-hint sk-hide-sm">{hint}</span> : null}
      {actions ? <div className="sk-panel-actions">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({
  children,
  tight,
  flush,
  className = "",
}: {
  children: ReactNode;
  tight?: boolean;
  flush?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`sk-panel-body${tight ? " sk-panel-body--tight" : ""}${flush ? " sk-panel-body--flush" : ""} ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export function PanelFoot({ children }: { children: ReactNode }) {
  return <div className="sk-panel-foot">{children}</div>;
}

/** Small uppercase section rule — orientation for dense pages. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`sk-eyebrow ${className}`.trim()}>{children}</div>;
}

/* ------------------------------------------------------------------- status */

const TONE_ICON: Record<Tone, ReactNode> = {
  ok: <Check size={12} strokeWidth={2} />,
  warn: <Warning size={12} strokeWidth={1.9} />,
  danger: <Warning size={12} strokeWidth={1.9} />,
  info: <Info size={12} strokeWidth={1.9} />,
  neutral: <span className="sk-swatch" style={{ background: "var(--neutral-fg)" }} />,
};

/**
 * Status is never carried by colour alone: the tone sets the palette and the
 * label always states the condition in words.
 */
export function Status({
  tone,
  children,
  icon,
  plain,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  icon?: ReactNode;
  plain?: boolean;
  title?: string;
}) {
  return (
    <span
      className={`sk-status${plain ? " sk-status--plain" : ""}`}
      style={
        {
          "--tone-fg": `var(--${tone}-fg)`,
          "--tone-bg": `var(--${tone}-bg)`,
          "--tone-line": `var(--${tone}-line)`,
        } as React.CSSProperties
      }
      title={title}
    >
      {icon ?? TONE_ICON[tone]}
      {children}
    </span>
  );
}

export function SourceTag({ kind }: { kind: "OBSERVED" | "FORECAST" | "MODEL PREDICTION" | "DEMO" }) {
  const short = kind === "MODEL PREDICTION" ? "MODEL" : kind === "DEMO" ? "DEMONSTRATION" : kind;
  return (
    <span className="sk-tag" data-kind={kind} title={kind === "DEMO" ? "Demonstration data — not a live observation" : kind}>
      {short}
    </span>
  );
}

/** Signed change with an explicit direction word for screen readers. */
export function Delta({
  value,
  unit = "",
  digits = 1,
  invertGood,
  neutral,
}: {
  value: number | null | undefined;
  unit?: string;
  digits?: number;
  /** true when a rise is bad (e.g. wave height) */
  invertGood?: boolean;
  /** true when neither direction is inherently good (e.g. temperature) */
  neutral?: boolean;
}) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return <span className="sk-delta" data-dir="flat">no change data</span>;
  }
  const dir = Math.abs(value) < 0.005 ? "flat" : value > 0 ? "up" : "down";
  const good = invertGood ? value < 0 : value > 0;
  const Icon = dir === "up" ? TrendUp : dir === "down" ? TrendDown : null;
  return (
    <span
      className="sk-delta"
      data-dir={dir === "flat" || neutral ? "flat" : good ? "up" : "down"}
      title={`${value > 0 ? "rise" : value < 0 ? "fall" : "no change"} of ${Math.abs(value).toFixed(digits)}${unit}`}
    >
      {Icon ? <Icon size={12} strokeWidth={2} /> : <span aria-hidden>—</span>}
      {value > 0 ? "+" : value < 0 ? "−" : ""}
      {Math.abs(value).toFixed(digits)}
      {unit}
    </span>
  );
}

/* ------------------------------------------------------------------ buttons */

export function Button({
  children,
  variant = "default",
  size,
  busy,
  block,
  icon,
  ...rest
}: {
  children?: ReactNode;
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm";
  busy?: boolean;
  block?: boolean;
  icon?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`sk-btn${variant !== "default" ? ` sk-btn--${variant}` : ""}${size === "sm" ? " sk-btn--sm" : ""}${block ? " sk-btn--block" : ""}`}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Refresh size={14} /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  children,
  ...rest
}: { label: string; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="sk-iconbtn" aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------- fields */

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  hideLabel,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  /** Keep the label for screen readers when a visible label would repeat. */
  hideLabel?: boolean;
}) {
  return (
    <div className="sk-field">
      <label htmlFor={htmlFor} className={hideLabel ? "sk-sr" : undefined}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="sk-field-error" role="alert">
          <Warning size={12} /> {error}
        </span>
      ) : hint ? (
        <span className="sk-field-help">{hint}</span>
      ) : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  describedBy,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      className="sk-switch"
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  label: string;
}) {
  return (
    <div className="sk-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="sk-seg-item"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="sk-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          className="sk-tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.count !== undefined ? <span className="sk-tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function CheckRow({
  checked,
  onChange,
  label,
  detail,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  detail?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="sk-check" style={disabled ? { opacity: 0.5 } : undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {detail ? <small>{detail}</small> : null}
      </span>
    </label>
  );
}

export function RadioRow({
  checked,
  onChange,
  name,
  value,
  label,
  detail,
}: {
  checked: boolean;
  onChange: () => void;
  name: string;
  value: string;
  label: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <label className="sk-radio">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} />
      <span>
        {label}
        {detail ? <small style={{ display: "block", fontSize: 10.5, color: "var(--dim)", marginTop: 2 }}>{detail}</small> : null}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ readout */

export type ReadoutItem = {
  key: string;
  label: string;
  value: string;
  unit?: string;
  /** the meaning of the number, stated in words */
  status: { tone: Tone; label: string };
  delta?: ReactNode;
  source?: ReactNode;
};

/**
 * The conditions strip. Deliberately *not* six identical cards — one band,
 * hairline separators, and a tone rule along the top of each cell.
 */
export function Readout({ items, ariaLabel }: { items: ReadoutItem[]; ariaLabel: string }) {
  return (
    <div className="sk-readout" role="group" aria-label={ariaLabel}>
      {items.map((it) => (
        <div
          className="sk-readout-cell"
          key={it.key}
          style={{ "--tone-accent": `var(--${it.status.tone}-line)` } as React.CSSProperties}
        >
          <div className="sk-readout-label">{it.label}</div>
          <div className="sk-readout-value">
            {it.value}
            {it.unit ? <span>{it.unit}</span> : null}
          </div>
          <div className="sk-readout-meta">
            {it.delta}
            <Status tone={it.status.tone} plain>
              {it.status.label}
            </Status>
          </div>
          {it.source ? <div className="sk-readout-src">{it.source}</div> : null}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ monk's reading */

export function Reading({
  text,
  window,
  basedOn,
  confidence,
  action,
  className = "",
}: {
  text: string;
  window?: string;
  basedOn?: string[];
  confidence?: number;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`sk-reading ${className}`.trim()} aria-labelledby="sk-reading-title">
      <div className="sk-reading-head">
        <Beacon size={17} />
        <span className="sk-reading-title" id="sk-reading-title">
          Monk&apos;s Reading
        </span>
        {window ? <span className="sk-reading-window">{window}</span> : null}
      </div>
      <div className="sk-reading-body">
        <p>{text}</p>
        {basedOn?.length ? (
          <div className="sk-reading-basis">
            <b>Interpretation drawn from</b>
            {basedOn.map((b) => (
              <span key={b}>{b}</span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="sk-reading-foot">
        {confidence !== undefined ? (
          <>
            <span>Model confidence</span>
            <span className="sk-val">{confidence}%</span>
            <span className="sk-progress sk-grow" style={{ maxWidth: 130 }}>
              <i style={{ width: `${confidence}%` }} />
            </span>
          </>
        ) : null}
        {action ? <span className="sk-spread">{action}</span> : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ timeline */

export type TimelineEntry = {
  time: string;
  label: string;
  detail: string;
  tone: Tone;
};

export function Timeline({ items, ariaLabel }: { items: TimelineEntry[]; ariaLabel: string }) {
  return (
    <ol className="sk-timeline" aria-label={ariaLabel} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((it) => (
        <li className="sk-timeline-item" key={`${it.time}-${it.label}`}>
          <span className="sk-timeline-time">{it.time}</span>
          <span className="sk-timeline-axis" aria-hidden>
            <span
              className="sk-timeline-node"
              style={
                {
                  "--tone-fg": `var(--${it.tone}-fg)`,
                  "--tone-line": `var(--${it.tone}-line)`,
                } as React.CSSProperties
              }
            />
          </span>
          <span className="sk-timeline-body">
            <b>{it.label}</b>
            <p>{it.detail}</p>
          </span>
        </li>
      ))}
    </ol>
  );
}

/* --------------------------------------------------------------------- table */

export type Column<T> = {
  key: string;
  header: ReactNode;
  align?: "left" | "right";
  width?: number | string;
  /** Provide to enable sorting on this column. */
  sortValue?: (row: T) => number | string;
  render: (row: T) => ReactNode;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  initialSortKey,
  initialSortDir = "desc",
  selectedKey,
  onRowActivate,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  caption?: ReactNode;
  empty?: ReactNode;
  initialSortKey?: string;
  initialSortDir?: "asc" | "desc";
  selectedKey?: string | null;
  onRowActivate?: (row: T) => void;
}) {
  const [sortKey, setSortKey] = useState<string | null>(initialSortKey ?? null);
  const [dir, setDir] = useState<"asc" | "desc">(initialSortDir);

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, columns, sortKey, dir]);

  if (!rows.length) {
    return <div className="sk-panel-body">{empty ?? <EmptyState title="Nothing to show" body="No rows match the current filters." />}</div>;
  }

  const toggle = (key: string) => {
    if (sortKey === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setDir("desc");
    }
  };

  return (
    <div className="sk-tablewrap">
      <table className="sk-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sortKey === c.key;
              return (
                <th
                  key={c.key}
                  style={{ width: c.width, textAlign: c.align === "right" ? "right" : "left" }}
                  aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {c.sortValue ? (
                    <button type="button" onClick={() => toggle(c.key)}>
                      {c.header}
                      {active ? (
                        <span className="sk-table-sort" aria-hidden>
                          {dir === "asc" ? "▲" : "▼"}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                data-selected={selectedKey === key || undefined}
                onClick={onRowActivate ? () => onRowActivate(row) : undefined}
                style={onRowActivate ? { cursor: "pointer" } : undefined}
                tabIndex={onRowActivate ? 0 : undefined}
                onKeyDown={
                  onRowActivate
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onRowActivate(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align === "right" ? "right" : "left" }}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------- states and notices */

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="sk-empty">
      <Beacon size={26} strokeWidth={1.4} />
      <b>{title}</b>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Skeleton({ height = 12, width = "100%", radius }: { height?: number; width?: number | string; radius?: number }) {
  return <div className="sk-skel" style={{ height, width, borderRadius: radius }} />;
}

export function Alert({
  tone = "info",
  title,
  children,
  demo,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
  demo?: boolean;
  action?: ReactNode;
}) {
  const Icon = tone === "ok" ? Check : tone === "warn" || tone === "danger" ? Warning : Info;
  return (
    <div
      className={`sk-alert${demo ? " sk-alert--demo" : ""}`}
      style={
        {
          "--tone-fg": `var(--${tone}-fg)`,
          "--tone-bg": `var(--${tone}-bg)`,
          "--tone-line": `var(--${tone}-line)`,
        } as React.CSSProperties
      }
      role={tone === "danger" ? "alert" : "status"}
    >
      <Icon size={15} />
      <span>
        {title ? <b>{title} </b> : null}
        {children}
      </span>
      {action ? <span className="sk-spread">{action}</span> : null}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="sk-note">
      <Info size={13} />
      <span>{children}</span>
    </div>
  );
}

/* -------------------------------------------------------------------- drawer */

export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  side = "right",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  side?: "right" | "left";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="sk-scrim" onClick={onClose} />
      <div
        className={side === "left" ? "sk-rail-drawer" : "sk-drawer"}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Panel"}
      >
        <div className="sk-drawer-head">
          <h2>{title}</h2>
          <span className="sk-spread" />
          <IconButton label="Close panel" onClick={onClose}>
            <Close size={15} />
          </IconButton>
        </div>
        <div className="sk-drawer-body">{children}</div>
        {footer ? <div className="sk-drawer-foot">{footer}</div> : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ time text */

/**
 * Relative time is only rendered after hydration so the prerendered export and
 * the hydrated client show the same string.
 */
export function TimeAgo({ value, prefix = "" }: { value: string | number; prefix?: string }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="sk-dim">—</span>;
  return <span>{prefix}{relLabel(value)}</span>;
}

export function relLabel(value: string | number): string {
  const t = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(t)) return "—";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/* -------------------------------------------------------------------- legend */

export function LegendRamp({
  label,
  gradient,
  ticks,
  unit,
}: {
  label: string;
  gradient: string;
  ticks: number[];
  unit: string;
}) {
  return (
    <div className="sk-legend-row">
      <span className="sk-legend-name">{label}</span>
      <span className="sk-legend-ramp" style={{ background: gradient }} />
      <span className="sk-legend-ticks">
        {ticks.map((t) => (
          <span key={t}>
            {t}
            {unit}
          </span>
        ))}
      </span>
    </div>
  );
}

export function LegendKey({ color, label, shape = "square", outline }: { color: string; label: string; shape?: "square" | "circle" | "line"; outline?: boolean }) {
  return (
    <span className="sk-legend-key">
      <span
        className="sk-swatch"
        style={{
          background: outline ? "transparent" : color,
          border: outline ? `1.5px solid ${color}` : undefined,
          borderRadius: shape === "circle" ? "50%" : shape === "line" ? 1 : 2,
          width: shape === "circle" ? 9 : 10,
          height: shape === "line" ? 2 : shape === "circle" ? 9 : 10,
        }}
      />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------- sources */

export function SourceRow({
  icon,
  name,
  status,
  note,
  metrics,
}: {
  icon: ReactNode;
  name: string;
  status: { tone: Tone; label: string };
  note: ReactNode;
  metrics: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="sk-src">
      <span className="sk-src-name">
        {icon}
        {name}
      </span>
      <Status tone={status.tone}>{status.label}</Status>
      <span className="sk-src-note">{note}</span>
      <span className="sk-src-metrics">
        {metrics.map((m) => (
          <span key={m.label}>
            {m.label}
            <b>{m.value}</b>
          </span>
        ))}
      </span>
    </div>
  );
}
