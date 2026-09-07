import type { UserBrowserDownload } from "@kestrel/shared-types";

export function compactDownloadBytes(value: number): string {
	const normalized = Math.max(0, value);
	if (normalized >= 1_000_000_000)
		return `${(normalized / 1_000_000_000).toFixed(1)} GB`;
	if (normalized >= 1_000_000)
		return `${(normalized / 1_000_000).toFixed(1)} MB`;
	if (normalized >= 1_000)
		return `${Math.round(normalized / 1_000)} KB`;
	return `${normalized} B`;
}

export function downloadProgress(
	download: Pick<UserBrowserDownload, "receivedBytes" | "totalBytes">,
): number | undefined {
	if (download.totalBytes <= 0) return undefined;
	return Math.min(
		100,
		Math.round((Math.max(0, download.receivedBytes) / download.totalBytes) * 100),
	);
}

export function downloadSizeLabel(download: Pick<
	UserBrowserDownload,
	"receivedBytes" | "totalBytes" | "status"
>): string {
	const receivedBytes = Math.max(0, download.receivedBytes);
	const totalBytes = Math.max(0, download.totalBytes);
	if (download.status === "progressing") {
		return totalBytes > 0
			? `${compactDownloadBytes(receivedBytes)} of ${compactDownloadBytes(totalBytes)}`
			: `${compactDownloadBytes(receivedBytes)} downloaded`;
	}
	if (download.status === "completed")
		return compactDownloadBytes(Math.max(receivedBytes, totalBytes));
	return compactDownloadBytes(receivedBytes);
}

export function downloadStatusLabel(
	status: UserBrowserDownload["status"],
): string {
	return {
		completed: "Completed",
		cancelled: "Cancelled",
		failed: "Failed",
		progressing: "Downloading",
	}[status];
}

export function downloadTimeRemaining(
	download: Pick<
		UserBrowserDownload,
		"receivedBytes" | "totalBytes" | "startedAt"
	>,
	now = Date.now(),
): string {
	const receivedBytes = Math.max(0, download.receivedBytes);
	const remainingBytes = Math.max(0, download.totalBytes - receivedBytes);
	const startedAt = Date.parse(download.startedAt);
	const elapsedSeconds = (now - startedAt) / 1_000;
	if (
		download.totalBytes <= 0 ||
		receivedBytes <= 0 ||
		!Number.isFinite(elapsedSeconds) ||
		elapsedSeconds <= 0
	)
		return "Estimating…";
	if (remainingBytes === 0) return "0s left";

	const bytesPerSecond = receivedBytes / Math.max(1, elapsedSeconds);
	const seconds = Math.max(1, Math.ceil(remainingBytes / bytesPerSecond));
	if (seconds < 60) return `${seconds}s left`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m left`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0
		? `${hours}h ${remainingMinutes}m left`
		: `${hours}h left`;
}
