// Minimal typing for the prebuilt plotly bundle (loaded lazily by the
// results dashboard; only the surface we call).
declare module 'plotly.js-basic-dist-min' {
	interface PlotlyStatic {
		newPlot(
			root: HTMLElement,
			data: unknown[],
			layout?: Record<string, unknown>,
			config?: Record<string, unknown>,
		): Promise<unknown>;
		purge(root: HTMLElement): void;
		Plots: { resize(root: HTMLElement): void };
	}
	const Plotly: PlotlyStatic;
	export default Plotly;
}
