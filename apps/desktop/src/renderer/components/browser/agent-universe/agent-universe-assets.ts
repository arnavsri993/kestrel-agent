import earthUrl from "../../../assets/agent-universe/earth.jpg";
import enceladusUrl from "../../../assets/agent-universe/enceladus.jpg";
import europaUrl from "../../../assets/agent-universe/europa.jpg";
import ganymedeUrl from "../../../assets/agent-universe/ganymede.jpg";
import ioUrl from "../../../assets/agent-universe/io.jpg";
import jupiterUrl from "../../../assets/agent-universe/jupiter.jpg";
import marsUrl from "../../../assets/agent-universe/mars.jpg";
import mercuryUrl from "../../../assets/agent-universe/mercury.jpg";
import neptuneUrl from "../../../assets/agent-universe/neptune.jpg";
import plutoUrl from "../../../assets/agent-universe/pluto.jpg";
import saturnUrl from "../../../assets/agent-universe/saturn.jpg";
import titanUrl from "../../../assets/agent-universe/titan.jpg";
import tritonUrl from "../../../assets/agent-universe/triton.jpg";
import uranusUrl from "../../../assets/agent-universe/uranus.jpg";
import venusUrl from "../../../assets/agent-universe/venus.jpg";
import type { AgentPlanetAssetId } from "@kestrel/shared-types";
import { stableAgentHash } from "./agent-universe-model";

export interface AgentUniverseBodyAsset {
	id: string;
	label: string;
	url: string;
	role: "planet" | "moon";
	source: "NASA/JPL-Caltech";
	sourceUrl: string;
	license: "Public domain — NASA media";
}

const NASA_GALLERIES = "https://solarsystem.nasa.gov";

/**
 * These are checked-in, optimized derivatives of public-domain NASA/JPL
 * Solar System imagery. Keep the source and license next to the import so an
 * asset can never silently become an unattributed remote URL.
 */
export const AGENT_UNIVERSE_BODY_ASSETS: readonly AgentUniverseBodyAsset[] = [
	{
		id: "earth",
		label: "Earth",
		url: earthUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/planets/earth/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "mars",
		label: "Mars",
		url: marsUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/planets/mars/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "jupiter",
		label: "Jupiter",
		url: jupiterUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/planets/jupiter/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "saturn",
		label: "Saturn",
		url: saturnUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/planets/saturn/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "venus",
		label: "Venus",
		url: venusUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/planets/venus/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "mercury",
		label: "Mercury",
		url: mercuryUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/planets/mercury/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "uranus",
		label: "Uranus",
		url: uranusUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/planets/uranus/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "neptune",
		label: "Neptune",
		url: neptuneUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/planets/neptune/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "pluto",
		label: "Pluto",
		url: plutoUrl,
		role: "planet",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/dwarf-planets/pluto/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "io",
		label: "Io",
		url: ioUrl,
		role: "moon",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/moons/jupiter-moons/io/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "europa",
		label: "Europa",
		url: europaUrl,
		role: "moon",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/moons/jupiter-moons/europa/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "ganymede",
		label: "Ganymede",
		url: ganymedeUrl,
		role: "moon",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/moons/jupiter-moons/ganymede/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "titan",
		label: "Titan",
		url: titanUrl,
		role: "moon",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/moons/saturn-moons/titan/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "triton",
		label: "Triton",
		url: tritonUrl,
		role: "moon",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/moons/neptune-moons/triton/galleries/`,
		license: "Public domain — NASA media",
	},
	{
		id: "enceladus",
		label: "Enceladus",
		url: enceladusUrl,
		role: "moon",
		source: "NASA/JPL-Caltech",
		sourceUrl: `${NASA_GALLERIES}/moons/saturn-moons/enceladus/galleries/`,
		license: "Public domain — NASA media",
	},
];

export const AGENT_UNIVERSE_PLANET_ASSETS = AGENT_UNIVERSE_BODY_ASSETS.filter(
	(asset) => asset.role === "planet",
);
const MOON_ASSETS = AGENT_UNIVERSE_BODY_ASSETS.filter(
	(asset) => asset.role === "moon",
);

export function agentUniverseBodyAssetFor(
	agentId: string,
	isRoot: boolean,
	planetAssetId?: AgentPlanetAssetId,
): AgentUniverseBodyAsset {
	if (isRoot && planetAssetId) {
		const configured = AGENT_UNIVERSE_PLANET_ASSETS.find(
			(asset) => asset.id === planetAssetId,
		);
		if (configured) return configured;
	}
	const assets = isRoot ? AGENT_UNIVERSE_PLANET_ASSETS : MOON_ASSETS;
	return assets[stableAgentHash(agentId) % assets.length]!;
}

export function agentUniverseAssetClipId(agentId: string): string {
	return `agent-universe-asset-${stableAgentHash(agentId).toString(16)}`;
}
