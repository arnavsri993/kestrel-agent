/** Fit a composer to its text, including when its panel changes width. */
export function observeTextareaSize(textarea: HTMLTextAreaElement): () => void {
	let previousConstraints = "";
	const constraints = () =>
		`${textarea.clientWidth}:${getComputedStyle(textarea).maxHeight}`;
	const resize = () => {
		if (!textarea.clientWidth) return;
		previousConstraints = constraints();
		const maximum = Number.parseFloat(getComputedStyle(textarea).maxHeight);
		textarea.style.height = "auto";
		const border = textarea.offsetHeight - textarea.clientHeight;
		textarea.style.height = `${Math.min(
			textarea.scrollHeight + border,
			Number.isFinite(maximum) ? maximum : 180,
		)}px`;
		textarea.style.overflowY =
			textarea.scrollHeight > textarea.clientHeight ? "auto" : "hidden";
	};
	resize();
	if (typeof ResizeObserver === "undefined") return () => {};
	const observer = new ResizeObserver(() => {
		if (constraints() !== previousConstraints) resize();
	});
	observer.observe(textarea);
	return () => observer.disconnect();
}
