import { sitePath } from "../lib/site-path";

export type TeamMember = {
	name: string;
	role: string;
	bio: string;
	photoUrl?: `/${string}`;
	avatarText: string;
	github?: string;
	x?: string;
};

export const teamMembers: TeamMember[] = [
	{
		name: "Arnav Srivastava",
		role: "Lead Architect & Systems Engineering",
		bio: "Passionate about local-first systems, secure execution perimeters, and deterministic AI agent architectures for Apple Silicon.",
		avatarText: "AS",
		github: "https://github.com/arnavsri993",
		x: "https://x.com/arnavsri993",
	},
	{
		name: "Claire Moreau",
		role: "Security & Sandbox Infrastructure",
		bio: "Specializing in macOS IPC sandboxing, Keychain encryption boundaries, and least-privilege system permission policies.",
		avatarText: "CM",
		github: "https://github.com/arnavsri993/kestrel-agent",
	},
	{
		name: "Julian Keller",
		role: "Inference & Runtime Engine",
		bio: "Optimizing Metal acceleration, local LLM quantization pipelines, and low-latency context retrieval engines.",
		avatarText: "JK",
		github: "https://github.com/arnavsri993/kestrel-agent",
	},
	{
		name: "Mei Lin",
		role: "Interface Design & Interaction Systems",
		bio: "Crafting tactile, high-density interfaces that make autonomous decisions transparent and approval boundaries unambiguous.",
		avatarText: "ML",
		x: "https://x.com/kestrelagent",
	},
];

export function TeamSection() {
	return (
		<section className="team-section" id="team" aria-labelledby="team-title">
			<div className="section-index">09 / CORE TEAM &amp; CONTRIBUTORS</div>
			<div className="section-heading">
				<h2 id="team-title">
					Built by engineers who care about control.
					<span>The team behind the local-first architecture.</span>
				</h2>
				<p>
					We are developers and security researchers building tools for our own daily workflows on macOS.
				</p>
			</div>

			<div className="team-grid">
				{teamMembers.map((member) => (
					<article key={member.name} className="team-card">
						<div className="team-photo-container">
							{member.photoUrl ? (
								<img
									src={sitePath(member.photoUrl)}
									alt={`Photo of ${member.name}, ${member.role}`}
									className="team-photo"
									loading="lazy"
								/>
							) : (
								<div
									className="team-photo-placeholder"
									aria-label={`Avatar for ${member.name}`}
								>
									<span className="team-initials">{member.avatarText}</span>
									<span className="team-photo-badge">Core</span>
								</div>
							)}
						</div>
						<div className="team-info">
							<h3 className="team-name">{member.name}</h3>
							<p className="team-role">{member.role}</p>
							<p className="team-bio">{member.bio}</p>
							<div className="team-socials">
								{member.github && (
									<a
										href={member.github}
										target="_blank"
										rel="noopener noreferrer"
										aria-label={`${member.name}'s GitHub Profile`}
										className="team-link"
									>
										GitHub
									</a>
								)}
								{member.x && (
									<a
										href={member.x}
										target="_blank"
										rel="noopener noreferrer"
										aria-label={`${member.name}'s Profile on X`}
										className="team-link"
									>
										X / Twitter
									</a>
								)}
							</div>
						</div>
					</article>
				))}
			</div>
		</section>
	);
}
