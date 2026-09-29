"use client";

/**
 * Confidence meter — the reliability of an ORCA answer, stated plainly.
 *
 * The score is *not* computed here: it arrives in the `confidence` payload the
 * platform's existing confidence engine produced for this specific answer
 * (`app/services/confidence.py`), together with the one-line justification and
 * the list of evidence factors behind it. This component only presents them, so
 * the number on screen and the number the engine calculated can never diverge.
 *
 * Presentation rules:
 *   · the percentage is the largest thing in the block and always visible;
 *   · the label (high / moderate / low) is spelled out, never colour-only;
 *   · "Why this score" expands in place to the real factors, so a fisher can
 *     see that e.g. a verified community report moved it;
 *   · no score is shown for a run that has no evidence to score (ordinary
 *     conversation) — an invented percentage would be worse than none.
 */

export type Confidence = {
  score: number;
  label: "high" | "moderate" | "low" | string;
  justification?: string;
  factors?: string[];
};

export function ConfidenceMeter({
  confidence,
  className = "",
  compact = false,
}: {
  confidence: Confidence | null | undefined;
  className?: string;
  /** Compact drops the label text on very narrow layouts. */
  compact?: boolean;
}) {
  if (!confidence || typeof confidence.score !== "number") return null;
  const score = Math.max(0, Math.min(100, Math.round(confidence.score)));
  const factors = (confidence.factors ?? []).filter(Boolean);

  return (
    <div
      className={`cm-meter ${className}`.trim()}
      data-label={confidence.label}
      aria-label={`${score} percent confidence, ${confidence.label}`}
    >
      <div className="cm-meter-row">
        <span className="cm-meter-track" aria-hidden>
          <i style={{ width: `${score}%` }} />
        </span>
        <b className="cm-meter-score">{score}%</b>
        <span className={`cm-meter-word${compact ? " cm-hide-narrow" : ""}`}>
          confidence{confidence.label ? ` · ${confidence.label}` : ""}
        </span>
      </div>

      {confidence.justification ? (
        <p className="cm-meter-why">{confidence.justification}</p>
      ) : null}

      {factors.length ? (
        <details className="cm-meter-more">
          <summary>Why {score}%?</summary>
          <ul>
            {factors.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p className="cm-meter-note">
            Scored from the evidence actually gathered for this question — a location you named,
            live sensor readings, the spatial hazard check, PFZ data, the safety knowledge base and
            any community report the sensors could corroborate.
          </p>
        </details>
      ) : null}
    </div>
  );
}
