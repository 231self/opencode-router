#!/usr/bin/env bun
/**
 * Print the compaction calibration: observed summary size, prediction error,
 * rebuild buckets, and sample counts per model.
 *
 * Usage:
 *   bun run compaction:report
 */

import { readCalibration } from "../src/calibration.js"
import { calibrationReport } from "../src/report.js"

console.log(calibrationReport(readCalibration()))
