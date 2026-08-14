export interface PublicRelease {
	available: boolean;
	version: string;
	downloadUrl?: string;
	manifestUrl?: string;
	checksumsUrl?: string;
}

function httpsUrl(
	value: string | undefined,
	suffix?: string,
): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:") return undefined;
		if (suffix && !url.pathname.toLowerCase().endsWith(suffix))
			return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

export function resolvePublicRelease(
	environment: Record<string, string | undefined>,
): PublicRelease {
	const version = environment.NEXT_PUBLIC_RELEASE_VERSION?.trim() ?? "";
	const downloadUrl = httpsUrl(environment.NEXT_PUBLIC_DOWNLOAD_URL, ".dmg");
	const manifestUrl = httpsUrl(
		environment.NEXT_PUBLIC_RELEASE_MANIFEST_URL,
		".json",
	);
	const checksumsUrl = httpsUrl(environment.NEXT_PUBLIC_RELEASE_CHECKSUMS_URL);
	const validVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
	const verified = environment.NEXT_PUBLIC_RELEASE_STATUS === "verified";
	const available = Boolean(
		verified && validVersion && downloadUrl && manifestUrl && checksumsUrl,
	);
	return {
		available,
		version: validVersion ? version : "0.1.0 development",
		...(downloadUrl ? { downloadUrl } : {}),
		...(manifestUrl ? { manifestUrl } : {}),
		...(checksumsUrl ? { checksumsUrl } : {}),
	};
}
