/**
 * Human-readable view of the compaction calibration. Offline: it reads the
 * artifact the plugin writes, so it works without a live session.
 */

function percent(value) {
  const number = Number(value) || 0
  return `${number < 0 ? "-" : "+"}${Math.round(Math.abs(number) * 100)}%`
}

function count(value) {
  return Math.round(Number(value) || 0).toString()
}

export function calibrationReport(calibration) {
  const models = calibration?.models ?? {}
  const keys = Object.keys(models).sort()
  if (keys.length === 0) {
    return "No compaction calibration yet. Run some turns and compact once."
  }
  return keys
    .map((key) => {
      const entry = models[key] ?? {}
      const lines = [key]
      const summary = entry.summary
      lines.push(
        `  summary      ${
          summary
            ? `${count(summary.value)} tokens (${summary.samples} samples)`
            : "assumed (no samples)"
        }`,
      )
      if (entry.lastPrediction) {
        const prediction = entry.lastPrediction
        lines.push(
          `  prediction   last ${count(prediction.predicted)} → ${count(prediction.actual)} ` +
            `(${percent(prediction.error)}), mean ${Math.round((Number(entry.error?.value) || 0) * 100)}%`,
        )
      }
      const rebuild = entry.rebuild
      lines.push(
        `  rebuild      ${
          rebuild
            ? `${count(rebuild.value.input)} in · ${count(rebuild.value.read)} read · ` +
              `${count(rebuild.value.write)} write (${rebuild.samples} samples)`
            : "not measured"
        }`,
      )
      if (entry.compactions) lines.push(`  compactions  ${entry.compactions}`)
      return lines.join("\n")
    })
    .join("\n\n")
}
