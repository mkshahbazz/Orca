"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ConsoleMap } from "@/components/seamonk/ConsoleMapClient";
import { Sparkline } from "@/components/seamonk/charts";
import {
  ArrowRight,
  Clock,
  Database,
  Download,
  FileCheck,
  FishingZones,
  MarineAnalytics,
  OceanWatch,
  Plus,
  Refresh,
  Reports,
  Satellite,
  Send,
  Share,
  ShieldCheck,
  Warning,
} from "@/components/seamonk/icons";
import {
  Alert,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  Eyebrow,
  Field,
  Note,
  Panel,
  PanelBody,
  PanelFoot,
  PanelHead,
  SourceTag,
  Status,
  type Column,
} from "@/components/seamonk/primitives";
import { useMounted, useSea } from "@/lib/seamonk/DataProvider";
import { LAYER_BY_KEY, rampGradient } from "@/lib/seamonk/design";
import { fieldSpec, hazardZones, pfzZones } from "@/lib/seamonk/derive";
import { coordLabel, istStamp, nm, num, sinceLabel } from "@/lib/seamonk/format";
import type { ReportRow } from "@/lib/seamonk/demo";

const REPORT_TYPES: Array<{
  id: string;
  name: string;
  description: string;
  sections: string;
  icon: typeof Reports;
}> = [
  {
    id: "daily",
    name: "Daily Marine Report",
    description: "Regional conditions, fishing outlook and the advisory list for the current watch period.",
    sections: "Conditions · PFZ · Weather · Advisories · Sources",
    icon: OceanWatch,
  },
  {
    id: "pfz",
    name: "Fishing Zone Report",
    description: "Zone-by-zone reasoning with the chlorophyll, temperature and depth evidence behind each entry.",
    sections: "Zone table · Evidence chain · Approach tracks",
    icon: FishingZones,
  },
  {
    id: "voyage",
    name: "Voyage Safety Report",
    description: "Track options with exposure per leg, hazard intersections and the recommended passage.",
    sections: "Tracks · Exposure · Hazards · Recommendation",
    icon: ShieldCheck,
  },
  {
    id: "conditions",
    name: "Ocean Conditions Report",
    description: "Parameter time series over a chosen window with statistics and data-quality accounting.",
    sections: "Series · Statistics · Correlation · Quality",
    icon: MarineAnalytics,
  },
  {
    id: "custom",
    name: "Custom Analysis",
    description: "Choose your own parameters, window and sections. Built for research write-ups.",
    sections: "Selectable",
    icon: Database,
  },
];

export default function ReportsView() {
  const sea = useSea();
  const mounted = useMounted();
  const [rows, setRows] = useState<ReportRow[]>(sea.reports);
  const [selectedId, setSelectedId] = useState<string>(sea.reports[0]?.id ?? "");
  const [statusFilter, setStatusFilter] = useState<"all" | ReportRow["status"]>("all");
  const [query, setQuery] = useState("");
  const [generating, setGenerating] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingType, setPendingType] = useState(REPORT_TYPES[0].id);

  const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const field = useMemo(() => fieldSpec("sst", sea.gridFor("sst"), true, 0.5), [sea.gridFor]);

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        const statusOk = statusFilter === "all" || r.status === statusFilter;
        const q = query.trim().toLowerCase();
        const queryOk = !q || `${r.title} ${r.region} ${r.author} ${r.type}`.toLowerCase().includes(q);
        return statusOk && queryOk;
      }),
    [rows, statusFilter, query]
  );

  const generate = (typeId: string) => {
    const type = REPORT_TYPES.find((t) => t.id === typeId)!;
    const id = `rp-${Math.floor(2420 + rows.length)}`;
    setGenerating(typeId);
    // The report body is assembled from data already held by the console.
    // Nothing is sent to a server in this build.
    window.setTimeout(() => {
      const row: ReportRow = {
        id,
        title: type.name,
        type: typeId === "daily" ? "Daily" : typeId === "pfz" ? "PFZ" : typeId === "voyage" ? "Voyage" : typeId === "conditions" ? "Conditions" : "Custom",
        region: sea.region.name,
        generatedAt: new Date().toISOString(),
        status: "ready",
        author: "You (Marine Explorer)",
        pages: typeId === "custom" ? 8 : 5,
        sizeKb: 240 + rows.length * 7,
      };
      setRows((r) => [row, ...r]);
      setSelectedId(id);
      setGenerating(null);
      setPickerOpen(false);
    }, 700);
  };

  const retryFailed = () => {
    if (!selected) return;
    setRegenerating(true);
    window.setTimeout(() => {
      setRows((r) =>
        r.map((x) =>
          x.id === selected.id
            ? { ...x, status: "ready", generatedAt: new Date().toISOString(), author: "SEAMONK scheduler", pages: 5, sizeKb: 368 }
            : x
        )
      );
      setRegenerating(false);
    }, 800);
  };

  const exportCsv = () => {
    if (!selected) return;
    const lines = [
      "THE SEAMONK — Marine Intelligence Report",
      `report_id,${selected.id}`,
      `title,${selected.title}`,
      `region,${selected.region}`,
      `generated,${istStamp(selected.generatedAt)}`,
      `author,${selected.author}`,
      `data_mode,${sea.mode}`,
      "",
      "SECTION,PARAMETER,VALUE,UNIT,TYPE,SOURCE",
      ...conditionsRows(sea).map((r) => [r.section, r.label, r.value, r.unit, r.kind, r.source].join(",")),
      "",
      "PFZ_ZONE,PROBABILITY,DISTANCE_NM,DEPTH_M,BEST_WINDOW",
      ...sea.pfz.map((z) => [z.name, z.probability, z.distanceNm, z.depthM, z.bestTime].join(",")),
    ];
    downloadBlob(lines.join("\n"), `seamonk-${selected.id}.csv`, "text/csv");
  };

  const share = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(
        `${selected.title} — ${selected.region} — generated ${istStamp(selected.generatedAt)} (THE SEAMONK report ${selected.id})`
      );
      setShared(true);
      window.setTimeout(() => setShared(false), 2000);
    } catch {
      setShared(false);
    }
  };

  const columns: Array<Column<ReportRow>> = [
    {
      key: "title",
      header: "Report",
      sortValue: (r) => r.title,
      render: (r) => (
        <span>
          <span className="sk-td-strong">{r.title}</span>
          <br />
          <span className="sk-td-dim">
            {r.id} · {r.type} report
          </span>
        </span>
      ),
    },
    { key: "region", header: "Region", sortValue: (r) => r.region, render: (r) => <span>{r.region}</span> },
    {
      key: "generatedAt",
      header: "Generated",
      sortValue: (r) => Date.parse(r.generatedAt),
      render: (r) => (
        <span>
          <span className="sk-val">{istStamp(r.generatedAt)}</span>
          <br />
          <span className="sk-td-dim">{mounted ? sinceLabel(r.generatedAt) : "—"}</span>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.status,
      render: (r) => (
        <Status tone={r.status === "ready" ? "ok" : r.status === "queued" ? "info" : "danger"}>
          {r.status === "ready" ? "Ready" : r.status === "queued" ? "In progress" : "Failed"}
        </Status>
      ),
    },
    { key: "author", header: "Author", sortValue: (r) => r.author, render: (r) => <span className="sk-td-dim">{r.author}</span> },
    {
      key: "action",
      header: "Action",
      align: "right",
      render: (r) => (
        <span className="sk-row" style={{ justifyContent: "flex-end", gap: 6 }}>
          <button
            type="button"
            className="sk-btn sk-btn--sm"
            onClick={() => setSelectedId(r.id)}
            disabled={r.status === "failed"}
          >
            {r.status === "failed" ? "Unavailable" : "Preview"}
          </button>
        </span>
      ),
    },
  ];

  return (
    <>
      <div className="sk-pagehead">
        <div className="sk-pagehead-txt">
          <h1>Reports</h1>
          <p>
            Generate, review and export marine intelligence reports. Preview is a real document layout — print or save
            it as a PDF from your browser.
          </p>
        </div>
        <div className="sk-pagehead-actions">
          <span className="sk-chip">
            <FileCheck size={13} /> {rows.filter((r) => r.status === "ready").length} ready ·{" "}
            {rows.filter((r) => r.status === "failed").length} failed
          </span>
          <Button variant="primary" icon={<Plus size={15} />} onClick={() => setPickerOpen(true)}>
            Generate report
          </Button>
        </div>
      </div>

      {/* ------------------------------------------------------- report types */}
      <Panel>
        <PanelHead icon={<Plus size={16} />} title="Report types" hint="Pick a template, then review the preview" />
        <PanelBody flush>
          <div className="sk-typelist">
            {REPORT_TYPES.map((t) => {
              const Icon = t.icon;
              return (
                <div className="sk-typerow" key={t.id}>
                  <span className="sk-typeicon">
                    <Icon size={16} />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className="sk-type-name">{t.name}</span>
                    <span className="sk-type-desc">{t.description}</span>
                    <span className="sk-dim-sm" style={{ display: "block", marginTop: 3 }}>
                      Sections: {t.sections}
                    </span>
                  </span>
                  <span className="sk-type-action">
                    <Button
                      size="sm"
                      busy={generating === t.id}
                      onClick={() => generate(t.id)}
                      disabled={!!generating}
                    >
                      {generating === t.id ? "Assembling" : "Generate"}
                    </Button>
                  </span>
                </div>
              );
            })}
          </div>
        </PanelBody>
        <PanelFoot>
          <span className="sk-dim-sm">
            Reports are assembled in the browser from the data this console is already holding. No server-side
            synthesis is claimed in this build.
          </span>
        </PanelFoot>
      </Panel>

      {/* ------------------------------------------------------ recent reports */}
      <Panel>
        <PanelHead
          icon={<Reports size={16} />}
          title="Recent reports"
          hint={`${filtered.length} of ${rows.length}`}
          actions={
            <div className="sk-row sk-gap-sm">
              <input
                className="sk-input"
                style={{ width: 180, height: 30 }}
                placeholder="Search title, region, author…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search reports"
              />
              <div className="sk-seg" role="group" aria-label="Filter by status">
                {(["all", "ready", "queued", "failed"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="sk-seg-item"
                    aria-pressed={statusFilter === s}
                    onClick={() => setStatusFilter(s)}
                  >
                    {s === "all" ? "All" : s === "ready" ? "Ready" : s === "queued" ? "In progress" : "Failed"}
                  </button>
                ))}
              </div>
            </div>
          }
        />
        <PanelBody flush>
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(r) => r.id}
            initialSortKey="generatedAt"
            selectedKey={selected?.id ?? null}
            onRowActivate={(r) => r.status !== "failed" && setSelectedId(r.id)}
            empty={
              <EmptyState
                title="No reports match"
                body="Clear the search box or choose a different status filter."
                action={
                  <button
                    type="button"
                    className="sk-btn sk-btn--sm"
                    onClick={() => {
                      setQuery("");
                      setStatusFilter("all");
                    }}
                  >
                    Reset filters
                  </button>
                }
              />
            }
          />
        </PanelBody>
      </Panel>

      {/* ----------------------------------------------------------- preview */}
      {selected && selected.status === "failed" ? (
        <Panel>
          <PanelHead icon={<Warning size={16} />} title={`Report ${selected.id} — generation failed`} />
          <PanelBody>
            <Alert tone="danger" title="This report did not complete.">
              The spatial store did not answer within the timeout while assembling section 2. Nothing is shown in its
              place — a partial report would be misleading.
            </Alert>
            <div className="sk-row" style={{ marginTop: 12 }}>
              <Button onClick={retryFailed} busy={regenerating} icon={<Refresh size={14} />}>
                {regenerating ? "Retrying" : "Retry generation"}
              </Button>
              <Button variant="ghost" onClick={() => setSelectedId(rows[0]?.id ?? "")}>
                Back to the latest report
              </Button>
            </div>
            <div style={{ marginTop: 12 }}>
              <Note>
                Failure details are kept with the record so the same fault is not silently retried in a loop.
              </Note>
            </div>
          </PanelBody>
        </Panel>
      ) : selected ? (
        <Panel>
          <PanelHead
            icon={<FileCheck size={16} />}
            title="Report preview"
            hint={`${selected.pages} pages · ${selected.sizeKb} kB`}
            actions={
              <>
                <Button size="sm" icon={<Download size={13} />} onClick={exportCsv}>
                  Export CSV
                </Button>
                <Button size="sm" icon={<Share size={13} />} onClick={share}>
                  {shared ? "Link copied" : "Share"}
                </Button>
                <Button size="sm" onClick={() => window.print()}>
                  Print / PDF
                </Button>
                <Button size="sm" variant="primary" icon={<Send size={13} />} onClick={() => generate("daily")} busy={generating === "daily"}>
                  Regenerate
                </Button>
              </>
            }
          />
          <PanelBody>
            <article className="sk-doc sk-printable">
              <div className="sk-doc-inner">
                <div className="sk-doc-head">
                  <div>
                    <h3>THE SEAMONK</h3>
                    <p>Marine Intelligence Report — {selected.title}</p>
                  </div>
                  <div className="sk-doc-meta">
                    <b>{selected.id}</b>
                    <span>{istStamp(selected.generatedAt)}</span>
                    <span>{selected.region}</span>
                    <span>{selected.author}</span>
                  </div>
                </div>

                <section className="sk-doc-section">
                  <h4>1 · Executive summary</h4>
                  <p>
                    Conditions across the {sea.region.name} are {sea.conditions.wave_height_m < 2 ? "workable" : "deteriorating"}{" "}
                    for nearshore operations, with {num(sea.conditions.wind_kt, 0)} kt of wind from the{" "}
                    {sea.conditions.wind_dir} and a significant wave height of {num(sea.conditions.wave_height_m, 1)} m.
                    Sea surface temperature is {num(sea.conditions.sst_c, 1)} °C and chlorophyll-a stands at{" "}
                    {num(sea.conditions.chlorophyll_mgm3, 2)} mg/m³.
                  </p>
                  <div className="sk-doc-kv">
                    <div>
                      <span>Zones above threshold</span>
                      <b>{sea.pfz.filter((z) => z.probability >= 65).length}</b>
                    </div>
                    <div>
                      <span>Best zone</span>
                      <b>{sea.pfz[0]?.name ?? "—"}</b>
                    </div>
                    <div>
                      <span>Active hazards</span>
                      <b>{sea.hazards.length}</b>
                    </div>
                    <div>
                      <span>Model confidence</span>
                      <b>{sea.readings.ocean.confidence}%</b>
                    </div>
                  </div>
                </section>

                <section className="sk-doc-section">
                  <h4>2 · Regional conditions</h4>
                  <div className="sk-tablewrap">
                    <table className="sk-table">
                      <thead>
                        <tr>
                          <th>Parameter</th>
                          <th style={{ textAlign: "right" }}>Value</th>
                          <th>Type</th>
                          <th>Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {conditionsRows(sea).map((r) => (
                          <tr key={r.label}>
                            <td className="sk-td-strong">{r.label}</td>
                            <td className="sk-num" style={{ textAlign: "right" }}>
                              {r.value} {r.unit}
                            </td>
                            <td>
                              <SourceTag kind={r.kind} />
                            </td>
                            <td className="sk-td-dim">{r.source}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="sk-row" style={{ marginTop: 10, gap: 14, alignItems: "center" }}>
                    <span className="sk-dim-sm">Sea surface temperature, last 24 h</span>
                    <Sparkline points={sea.sstTrend} width={220} height={38} color="#33b9f2" label="SST trend, last 24 hours" />
                  </div>
                </section>

                <section className="sk-doc-section">
                  <h4>3 · Potential fishing zones</h4>
                  <div className="sk-tablewrap">
                    <table className="sk-table">
                      <thead>
                        <tr>
                          <th>Zone</th>
                          <th style={{ textAlign: "right" }}>Probability</th>
                          <th style={{ textAlign: "right" }}>Range</th>
                          <th style={{ textAlign: "right" }}>Depth</th>
                          <th>Best window</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sea.pfz.slice(0, 4).map((z) => (
                          <tr key={z.id}>
                            <td className="sk-td-strong">
                              {z.name}
                              <br />
                              <span className="sk-td-id">{coordLabel(z.lat, z.lon)}</span>
                            </td>
                            <td className="sk-num" style={{ textAlign: "right" }}>
                              {z.probability}%
                            </td>
                            <td className="sk-num" style={{ textAlign: "right" }}>
                              {nm(z.distanceNm, 0)}
                            </td>
                            <td className="sk-num" style={{ textAlign: "right" }}>
                              {z.depthM} m
                            </td>
                            <td className="sk-td-dim">{z.bestTime}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="sk-doc-section">
                  <h4>4 · Weather outlook</h4>
                  <div className="sk-doc-kv">
                    {sea.forecast.slice(0, 4).map((f) => (
                      <div key={f.time}>
                        <span>{f.time} IST</span>
                        <b>
                          {f.wind_kt} kt · {num(f.temp_c, 1)} °C · sea {f.sea}
                        </b>
                      </div>
                    ))}
                  </div>
                  <p style={{ marginTop: 10 }}>
                    Wind is expected to {sea.forecast[0] && sea.forecast[1] && sea.forecast[1].wind_kt > sea.forecast[0].wind_kt ? "freshen" : "hold"} through the watch period.
                    Wave conditions track the wind with a lag of roughly three hours.
                  </p>
                </section>

                <section className="sk-doc-section">
                  <h4>5 · Safety assessment</h4>
                  <p>
                    {sea.hazards.filter((h) => h.severity === "hazard").length} notice
                    {sea.hazards.filter((h) => h.severity === "hazard").length === 1 ? "" : "s"} in this region require a
                    routing decision rather than a caution. The nearest is {sea.hazards[0]?.label}, valid{" "}
                    {sea.hazards[0]?.validUntil}.
                  </p>
                  <div className="sk-doc-kv">
                    {sea.hazards.slice(0, 4).map((h) => (
                      <div key={h.id}>
                        <span>{h.severity === "hazard" ? "Hazard" : h.severity === "caution" ? "Caution" : "Advisory"}</span>
                        <b>{h.label}</b>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="sk-doc-section">
                  <h4>6 · Spatial overview</h4>
                  <div className="sk-doc-map">
                    <ConsoleMap
                      ariaLabel="Spatial overview for this report"
                      fields={[field]}
                      zones={[...pfzZones(sea.pfz), ...hazardZones(sea.hazards)]}
                      center={[sea.region.lat, sea.region.lon]}
                      zoom={6}
                      height={240}
                      basemap="dark"
                      showTools={false}
                      fitPoints={[
                        [16.2, 82.2],
                        [22.0, 89.6],
                      ]}
                      fitKey={1}
                      fitMaxZoom={6}
                    />
                  </div>
                  <p className="sk-dim-sm" style={{ marginTop: 8 }}>
                    Shaded field: {LAYER_BY_KEY.sst.label}, {LAYER_BY_KEY.sst.resolution} grid. Green outlines are fishing
                    zones, dashed outlines are hazard and restricted areas.
                  </p>
                  <div className="sk-legend-row" style={{ marginTop: 8, gridTemplateColumns: "78px 200px" }}>
                    <span className="sk-legend-name">SST</span>
                    <span className="sk-legend-ramp" style={{ background: rampGradient("sst") }} />
                  </div>
                </section>

                <section className="sk-doc-section">
                  <h4>7 · Data sources and confidence</h4>
                  <div className="sk-doc-kv">
                    {sea.sources.map((s) => (
                      <div key={s.key}>
                        <span>{s.label}</span>
                        <b>
                          {s.status === "active" ? "Receiving" : s.status === "degraded" ? "Degraded" : "Offline"} ·{" "}
                          {s.coverage}% coverage
                        </b>
                      </div>
                    ))}
                  </div>
                  <p style={{ marginTop: 10 }}>
                    Overall report confidence {sea.readings.ocean.confidence}%. Surface fields are satellite-derived at 1–4 km
                    resolution and are not soundings. Fishing zone probabilities are model output from the published PFZ
                    bulletin and describe coincidence of conditions, not a catch forecast.
                  </p>
                </section>
              </div>

              <div className="sk-doc-foot">
                <span>THE SEAMONK · Marine intelligence for coastal operations</span>
                <span className="sk-spread" />
                <span>
                  {sea.mode === "demo"
                    ? "DEMONSTRATION DATASET — values are illustrative, not live observations"
                    : `Live feeds · generated ${mounted && sea.generatedAt ? istStamp(sea.generatedAt) : ""}`}
                </span>
              </div>
            </article>

            <div className="sk-row" style={{ marginTop: 12 }}>
              <Note>
                The preview is rendered from the same data the console displays. Print it or save as PDF from your
                browser&apos;s print dialog — the layout collapses to a single column automatically.
              </Note>
            </div>
          </PanelBody>
          <PanelFoot>
            <span className="sk-dim-sm">
              {selected.pages} pages · {selected.sizeKb} kB · {selected.type} template
            </span>
            <span className="sk-spread sk-row" style={{ gap: 10 }}>
              <Link className="sk-link" href="/dashboard/analytics/">
                Open the underlying series <ArrowRight size={12} />
              </Link>
            </span>
          </PanelFoot>
        </Panel>
      ) : (
        <Panel>
          <PanelBody>
            <EmptyState title="No report selected" body="Generate a report or pick one from the list above." />
          </PanelBody>
        </Panel>
      )}

      {/* ------------------------------------------------------ generate drawer */}
      <Drawer
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Generate a report"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" block busy={!!generating} onClick={() => generate(pendingType)}>
              {generating ? "Assembling report" : "Generate now"}
            </Button>
          </>
        }
      >
        <div>
              <Eyebrow>Template</Eyebrow>
              <div className="sk-stack" style={{ gap: 6, marginTop: 8 }}>
                {REPORT_TYPES.map((t) => (
                  <label className="sk-radio" key={t.id}>
                    <input
                      type="radio"
                      name="report-type"
                      checked={pendingType === t.id}
                      onChange={() => setPendingType(t.id)}
                    />
                    <span>
                      {t.name}
                      <small style={{ display: "block", fontSize: 10.5, color: "var(--dim)", marginTop: 2 }}>
                        {t.sections}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
              <div className="sk-hair" />
              <div className="sk-field-row">
                <Field label="Region" htmlFor="rp-region">
                  <input id="rp-region" className="sk-input" value={sea.region.name} readOnly />
                </Field>
                <Field label="Watch period" htmlFor="rp-period">
                  <select id="rp-period" className="sk-select" defaultValue="24">
                    <option value="24">Last 24 hours</option>
                    <option value="168">Last 7 days</option>
                    <option value="720">Last 30 days</option>
                  </select>
                </Field>
              </div>
              <div className="sk-hair" />
              <Eyebrow>Data used</Eyebrow>
              <div className="sk-stack" style={{ gap: 6, marginTop: 8 }}>
                <div className="sk-pair">
                  <span>
                    <Satellite size={13} /> Satellite fields
                  </span>
                  <span>{sea.sources[0].coverage}% coverage</span>
                </div>
                <div className="sk-pair">
                  <span>
                    <Clock size={13} /> Observation window
                  </span>
                  <span>{mounted ? sinceLabel(Date.now() - 26 * 60_000) : "—"}</span>
                </div>
                <div className="sk-pair">
                  <span>
                    <ShieldCheck size={13} /> Hazard register
                  </span>
                  <span>{sea.hazards.length} entries</span>
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                <Note>
                  {sea.mode === "demo"
                    ? "Live feeds are unreachable, so the generated report will carry the demonstration dataset and say so on its cover."
                    : "The report will carry live source labels and timestamps."}
                </Note>
              </div>
        </div>
      </Drawer>

    </>
  );
}

/* ---------------------------------------------------------------- helpers */

type ConditionRow = {
  section: string;
  label: string;
  value: string;
  unit: string;
  kind: "OBSERVED" | "FORECAST" | "MODEL PREDICTION";
  source: string;
};

function conditionsRows(sea: ReturnType<typeof useSea>): ConditionRow[] {
  return [
    {
      section: "Conditions",
      label: "Sea surface temperature",
      value: num(sea.conditions.sst_c, 1),
      unit: "°C",
      kind: "OBSERVED",
      source: "MOSDAC · INSAT-3DR",
    },
    {
      section: "Conditions",
      label: "Chlorophyll-a",
      value: num(sea.conditions.chlorophyll_mgm3, 2),
      unit: "mg/m³",
      kind: "OBSERVED",
      source: "Copernicus · Sentinel-3",
    },
    {
      section: "Conditions",
      label: "Wind",
      value: num(sea.conditions.wind_kt, 0),
      unit: `kt ${sea.conditions.wind_dir}`,
      kind: "FORECAST",
      source: "IMD · GFS blend",
    },
    {
      section: "Conditions",
      label: "Significant wave height",
      value: num(sea.conditions.wave_height_m, 1),
      unit: "m",
      kind: "MODEL PREDICTION",
      source: "INCOIS wave model",
    },
    {
      section: "Conditions",
      label: "Visibility",
      value: num(sea.conditions.visibility_km, 1),
      unit: "km",
      kind: "OBSERVED",
      source: "IMD coastal stations",
    },
    {
      section: "Conditions",
      label: "Sea state (Douglas)",
      value: sea.conditions.sea_state,
      unit: "",
      kind: "MODEL PREDICTION",
      source: "derived from wave height",
    },
  ];
}

function downloadBlob(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
