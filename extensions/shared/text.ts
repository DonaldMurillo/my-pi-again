/**
 * Shared text utilities for extensions.
 *
 * Truncate a string containing ANSI escape sequences + OSC 8 hyperlinks
 * so its *visible* width fits within maxW cells.
 *
 * Defensive: clips to maxW-2 to leave room for any surrounding control
 * sequences that the host TUI might add (e.g. OSC 8 end-tags, reset
 * sequences) which some terminals count toward visible width.
 */

/**
 * Measure the visible (cell) width of a string that may contain
 * ANSI CSI sequences and OSC 8 hyperlinks.
 */
export function visibleWidth(line: string): number {
	let vis = 0;
	let idx = 0;
	while (idx < line.length) {
		if (line[idx] === "\x1b") {
			// CSI sequence: \x1b[ ... <final byte>
			if (line[idx + 1] === "[") {
				const end = line.indexOf("m", idx + 2);
				if (end >= 0) {
					idx = end + 1;
					continue;
				}
			}
			// OSC sequence: \x1b] ... \x07 (BEL) or \x1b\\ (ST)
			if (line[idx + 1] === "]") {
				const bel = line.indexOf("\x07", idx + 2);
				const st = line.indexOf("\x1b\\", idx + 2);
				if (bel >= 0 && (st < 0 || bel < st)) {
					idx = bel + 1;
					continue;
				}
				if (st >= 0) {
					idx = st + 2;
					continue;
				}
			}
			// Unknown escape — skip the \x1b and hope for the best
			idx++;
			continue;
		}
		vis++;
		idx++;
	}
	return vis;
}

/**
 * Truncate a line containing ANSI/OSC sequences to fit within `maxW`
 * visible cells.  Returns the original line if already short enough,
 * otherwise clips and appends "…".
 *
 * @param safetyMargin  extra cells to reserve (default 2). The host TUI
 *                      may add its own control sequences that count as
 *                      visible width in some terminals.
 */
export function truncateToWidth(
	line: string,
	maxW: number,
	safetyMargin = 2,
): string {
	const target = maxW - safetyMargin;
	if (target <= 0) return "";

	let vis = 0;
	let cutPos = line.length;
	let idx = 0;

	while (idx < line.length) {
		if (line[idx] === "\x1b") {
			if (line[idx + 1] === "[") {
				const end = line.indexOf("m", idx + 2);
				if (end >= 0) {
					idx = end + 1;
					continue;
				}
			}
			if (line[idx + 1] === "]") {
				const bel = line.indexOf("\x07", idx + 2);
				const st = line.indexOf("\x1b\\", idx + 2);
				if (bel >= 0 && (st < 0 || bel < st)) {
					idx = bel + 1;
					continue;
				}
				if (st >= 0) {
					idx = st + 2;
					continue;
				}
			}
			idx++;
			continue;
		}
		vis++;
		if (vis > target) {
			cutPos = idx;
			break;
		}
		idx++;
	}

	return vis <= target ? line : line.slice(0, cutPos) + "\u2026";
}
