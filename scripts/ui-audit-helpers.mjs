export async function seedLifeContextFixture() {
	const now = new Date();
	const monday = new Date(now);
	monday.setHours(0, 0, 0, 0);
	monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
	const time = (day, hour, minutes = 0) => {
		const date = new Date(monday);
		date.setDate(date.getDate() + day);
		date.setHours(hour, minutes, 0, 0);
		return date.toISOString();
	};
	const requests = [
		{
			type: "calendar-create-local",
			title: "Deep work · Kestrel",
			startsAt: time(0, 9),
			endsAt: time(0, 11),
			origin: "explicit",
			confidence: 1,
			sourceId: "desktop-user",
		},
		{
			type: "calendar-create-local",
			title: "Likely commute",
			startsAt: time(1, 8, 15),
			endsAt: time(1, 8, 50),
			origin: "inferred",
			confidence: 0.76,
			sourceId: "routine-inference",
		},
		{
			type: "people-upsert",
			displayName: "Dr. Maya Chen",
			nicknames: ["Professor Chen"],
			relationship: "Professor",
			organization: "Lakeshore University",
			role: "Capstone adviser",
			email: "maya.chen@example.test",
			tone: "Brief, respectful, and prepared",
			formality: "formal",
			sourceId: "desktop-user",
			sensitivity: "personal",
		},
		{
			type: "memory-remember",
			memoryType: "project",
			content:
				"The Kestrel capstone review is the highest-priority project this month.",
			sensitivity: "personal",
			sourceId: "desktop-user",
			layer: "mid_term",
		},
	];
	for (const request of requests) {
		const response = await window.kestrel.request(request);
		if (!response.ok) throw new Error(response.error);
	}
}
